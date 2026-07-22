import { createServer, connect } from 'node:net';

const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;

function assertLoopback(host) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('supervision IPC may bind only to loopback');
}

function createPeer(socket, onRequest, onClose = () => {}) {
  let buffer = '';
  let sequence = 0;
  const pending = new Map();

  function send(value) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) throw new Error('supervision IPC response exceeds the maximum frame size');
    socket.write(`${encoded}\n`);
  }

  function rejectPending(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  const peer = {
    call(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const id = `rpc-${++sequence}`;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`supervision IPC request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject, timer });
        send({ type: 'request', id, method, params });
      });
    },
    notify(method, params) {
      send({ type: 'notification', method, params });
    },
    close() {
      socket.destroy();
    },
  };

  socket.setEncoding('utf8');
  socket.on('data', async chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES * 2) {
      socket.destroy(new Error('supervision IPC input exceeds the maximum frame size'));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        socket.destroy(new Error('supervision IPC frame exceeds the maximum frame size'));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy(new Error('supervision IPC received invalid JSON'));
        return;
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.ok) request.resolve(message.result); else request.reject(new Error(message.error ?? 'supervision IPC request failed'));
        continue;
      }
      if ((message.type === 'request' || message.type === 'notification') && typeof message.method === 'string') {
        try {
          const result = await onRequest(message, peer);
          if (message.type === 'request') send({ type: 'response', id: message.id, ok: true, result });
        } catch (error) {
          if (message.type === 'request') send({ type: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : 'supervision IPC request failed' });
        }
      }
    }
  });
  socket.on('error', rejectPending);
  socket.on('close', () => {
    rejectPending(new Error('supervision IPC connection closed'));
    onClose(peer);
  });
  return peer;
}

export async function createAuthenticatedIpcServer({ credential, projectRoot, runId, onRequest, onBridgeConnected = () => {}, onBridgeDisconnected = () => {} }) {
  if (typeof credential !== 'string' || credential.length < 32) throw new Error('supervision IPC requires a per-run credential');
  let bridge = null;
  const peers = new Set();
  const server = createServer(socket => {
    const peer = createPeer(socket, async (message, currentPeer) => {
      const auth = message.params?.auth;
      if (!auth || auth.credential !== credential || auth.project_root !== projectRoot || auth.run_id !== runId) {
        throw new Error('supervision IPC authentication or binding failed');
      }
      if (message.method === 'bridge.connect') {
        if (bridge && bridge !== currentPeer) throw new Error('an OpenCode bridge is already registered for this run');
        bridge = currentPeer;
        await onBridgeConnected(message.params ?? {}, currentPeer);
        return { connected: true };
      }
      return await onRequest(message.method, message.params, currentPeer);
    }, closedPeer => {
      peers.delete(closedPeer);
      if (bridge === closedPeer) {
        bridge = null;
        onBridgeDisconnected(closedPeer);
      }
    });
    peers.add(peer);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unable to create loopback supervision IPC listener');
  return {
    endpoint: { host: '127.0.0.1', port: address.port },
    callBridge(method, params, timeoutMs) {
      if (!bridge) throw new Error('OpenCode bridge is unavailable');
      return bridge.call(method, params, timeoutMs);
    },
    bridgeConnected: () => Boolean(bridge),
    close: () => new Promise(resolvePromise => {
      for (const peer of peers) peer.close();
      peers.clear();
      bridge = null;
      server.close(resolvePromise);
    }),
  };
}

export async function callAuthenticatedIpc(endpoint, auth, method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  assertLoopback(endpoint.host);
  const socket = connect({ host: endpoint.host, port: endpoint.port });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('supervision IPC connection timed out')), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolvePromise(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const peer = createPeer(socket, async () => { throw new Error('CLI clients do not accept controller callbacks'); });
  try {
    return await peer.call(method, { ...params, auth }, timeoutMs);
  } finally {
    peer.close();
  }
}

/**
 * Persistent authenticated peer used by host bridges and deterministic
 * integration tests. Unlike one-shot CLI calls it accepts controller callbacks.
 */
export async function connectAuthenticatedIpc(endpoint, auth, onRequest, timeoutMs = DEFAULT_TIMEOUT_MS) {
  assertLoopback(endpoint.host);
  const socket = connect({ host: endpoint.host, port: endpoint.port });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('supervision IPC connection timed out')), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolvePromise(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const peer = createPeer(socket, async message => {
    const params = message.params ?? {};
    return await onRequest(message.method, params);
  });
  return {
    call(method, params = {}, callTimeoutMs = timeoutMs) {
      return peer.call(method, { ...params, auth }, callTimeoutMs);
    },
    close() {
      peer.close();
    },
  };
}
