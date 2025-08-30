import HashFSWorker from './hashfs-worker.js?worker&inline'

let requestId = 0;
const pendingRequests = new Map();

export class WorkerManager {
  constructor() {
    this.worker = null;
    this.readyPromise = null;
    this.vaultHash = null;
    this.sessionHash = null;
  }

  async initWorker(retries = 3) {
    if (this.worker) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      if (typeof window === 'undefined' || typeof HashFSWorker === 'undefined') {
        throw new Error('Worker not available in this environment');
      }

      let attempt = 0;
      while (attempt < retries) {
        try {
          this.worker = new HashFSWorker();
          this.worker.onmessage = this.handleMessage.bind(this);
          this.worker.onerror = error => console.error('Worker error:', error);
          return;
        } catch (err) {
          attempt += 1;
          const backoff = 100 * Math.pow(2, attempt);
          await (new Promise(r => setTimeout(r, backoff)))
        }
      }

      this.readyPromise = null;
      throw new Error('Failed to initialize HashFS worker');
    })();

    return this.readyPromise;
  }

  handleMessage(e) {
    const { id, success, result, error, type, operationId } = e.data;

    if (type === 'init' && success && result.messageHash) {
      this.vaultHash = result.messageHash.base;
      this.sessionHash = result.messageHash.session;
    }

    if (type === 'progress' && operationId) {
      const handlers = state.progressHandlers.get(operationId);
      if (handlers) handlers.forEach(handler => handler(e.data));
      return;
    }

    const request = pendingRequests.get(id);
    if (request) {
      pendingRequests.delete(id);
      if (success) request.resolve(result);
      else request.reject(new Error(error));
    }
  }

  async sendToWorker(type, data = {}, operationId = null) {
    await this.initWorker();

    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      const transferable = [];
      if (data.bytes instanceof ArrayBuffer) transferable.push(data.bytes);
      if (data.arrayBuffer instanceof ArrayBuffer) transferable.push(data.arrayBuffer);

      try {
        this.worker.postMessage({ id, type, data, operationId }, transferable);
      } catch (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  terminate() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) { /* ignore */ }
      this.worker = null;
    }
    this.readyPromise = null;
    this.vaultHash = null;
    this.sessionHash = null;
  }
}
