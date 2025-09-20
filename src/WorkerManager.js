import HashFSWorker from './hashfs-worker.js?worker&inline'

let requestId = 0;
const pendingRequests = new Map();

// Global state for progress handlers (this was referenced but not defined)
const state = {
  progressHandlers: new Map()
};

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
      if (typeof window === 'undefined') {
        throw new Error('Worker not available in this environment');
      }

      let attempt = 0;
      while (attempt < retries) {
        try {
          this.worker = new HashFSWorker();
          this.worker.onmessage = this.handleMessage.bind(this);
          this.worker.onerror = (error) => {
            console.error('Worker error:', error);
            // Also reject any pending requests
            pendingRequests.forEach((request, id) => {
              request.reject(new Error('Worker error: ' + error.message));
              pendingRequests.delete(id);
            });
          };

          return;
        } catch (err) {
          console.warn(`Worker init attempt ${attempt + 1} failed:`, err);
          attempt += 1;
          if (attempt < retries) {
            const backoff = 100 * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, backoff));
          }
        }
      }

      this.readyPromise = null;
      throw new Error('Failed to initialize HashFS worker after ' + retries + ' attempts');
    })();

    return this.readyPromise;
  }

  handleMessage(e) {
    try {
      const { id, success, result, error, type, operationId } = e.data;

      // Handle progress messages
      if (type === 'progress' && operationId) {
        const handlers = state.progressHandlers.get(operationId);
        if (handlers) {
          handlers.forEach(handler => {
            try {
              handler(e.data);
            } catch (err) {
              console.warn('Progress handler error:', err);
            }
          });
        }
        return;
      }

      // Store vault/session hashes from init
      if (success && result && result.messageHash) {
        this.vaultHash = result.messageHash.base;
        this.sessionHash = result.messageHash.session;
      }

      // Handle request responses
      const request = pendingRequests.get(id);
      if (request) {
        pendingRequests.delete(id);
        if (success) {
          request.resolve(result);
        } else {
          const errorMsg = error || 'Unknown worker error';
          console.error('Worker request failed:', { type, error: errorMsg, id });
          request.reject(new Error(errorMsg));
        }
      } else {
        console.warn('Received response for unknown request ID:', id);
      }
    } catch (err) {
      console.error('Error handling worker message:', err, e.data);
    }
  }

  async sendToWorker(type, data = {}, operationId = null) {
    try {
      await this.initWorker();

      if (!this.worker) {
        throw new Error('Worker not initialized');
      }

      const id = ++requestId;

      return new Promise((resolve, reject) => {
        // Set up timeout for requests
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Worker request timeout for ${type} (ID: ${id})`));
        }, 30000); // 30 second timeout

        pendingRequests.set(id, {
          resolve: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timeout);
            console.error(`Worker error: ${type} (ID: ${id})`, error);
            reject(error);
          }
        });

        // Prepare transferable objects
        const transferable = [];
        if (data.bytes instanceof ArrayBuffer) {
          transferable.push(data.bytes);
        }
        if (data.arrayBuffer instanceof ArrayBuffer) {
          transferable.push(data.arrayBuffer);
        }
        if (data.files && Array.isArray(data.files)) {
          data.files.forEach(file => {
            if (file.bytes instanceof ArrayBuffer) {
              transferable.push(file.bytes);
            }
          });
        }

        try {
          this.worker.postMessage({ id, type, data, operationId }, transferable);
        } catch (err) {
          pendingRequests.delete(id);
          clearTimeout(timeout);
          console.error('Failed to post message to worker:', err);
          reject(new Error(`Failed to send message to worker: ${err.message}`));
        }
      });
    } catch (err) {
      console.error(`sendToWorker failed for ${type}:`, err);
      throw err;
    }
  }

  // Helper method to register progress handlers
  addProgressHandler(operationId, handler) {
    if (!state.progressHandlers.has(operationId)) {
      state.progressHandlers.set(operationId, new Set());
    }
    state.progressHandlers.get(operationId).add(handler);
  }

  // Helper method to remove progress handlers
  removeProgressHandler(operationId, handler = null) {
    if (handler) {
      const handlers = state.progressHandlers.get(operationId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          state.progressHandlers.delete(operationId);
        }
      }
    } else {
      state.progressHandlers.delete(operationId);
    }
  }

  // Expose current status for debugging
  getStatus() {
    return {
      hasWorker: !!this.worker,
      isReady: !!this.readyPromise,
      pendingRequests: pendingRequests.size,
      vaultHash: this.vaultHash?.slice(0, 16) + '...',
      sessionHash: this.sessionHash?.slice(0, 16) + '...'
    };
  }

  terminate() {
    // Reject all pending requests
    pendingRequests.forEach((request, id) => {
      request.reject(new Error('Worker terminated'));
      pendingRequests.delete(id);
    });

    // Clear progress handlers
    state.progressHandlers.clear();

    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {
        console.warn('Error terminating worker:', e);
      }
      this.worker = null;
    }

    this.readyPromise = null;
    this.vaultHash = null;
    this.sessionHash = null;
  }
}