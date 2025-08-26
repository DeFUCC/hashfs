// Bulk Operations Worker - Handles import/export of multiple files
class BulkWorker {
  constructor() {
    this.operations = new Map();
  }

  async importFiles(files, operationId) {
    const results = [];
    let completed = 0;

    for (const file of files) {
      try {
        // Read file data
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // Prepare data for main worker
        const transferData = {
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          bytes: bytes.buffer, // Transfer ArrayBuffer
          size: bytes.length
        };

        results.push({
          name: file.name,
          success: true,
          data: transferData
        });

      } catch (error) {
        results.push({
          name: file.name,
          success: false,
          error: error.message
        });
      }

      completed++;

      // Send progress update
      self.postMessage({
        type: 'progress',
        operationId,
        completed,
        total: files.length,
        current: file.name
      });
    }

    return results;
  }

  async exportFiles(fileData, operationId) {
    const exported = {};
    const entries = Object.entries(fileData);
    let completed = 0;

    for (const [name, data] of entries) {
      try {
        // Convert array back to Uint8Array
        const bytes = new Uint8Array(data.content);

        // Create transferable data
        const transferData = {
          bytes: bytes.buffer,
          mime: data.mime
        };

        exported[name] = transferData;

      } catch (error) {
        console.warn(`Export preparation failed for ${name}:`, error);
      }

      completed++;

      // Send progress update
      self.postMessage({
        type: 'progress',
        operationId,
        completed,
        total: entries.length,
        current: name
      });
    }

    return exported;
  }

  async processArchive(arrayBuffer, operationId) {
    // Simple archive processing - could be extended with zip/tar support
    const results = [];

    try {
      // For now, treat as JSON export format
      const text = new TextDecoder().decode(arrayBuffer);
      const data = JSON.parse(text);

      const entries = Object.entries(data);
      let completed = 0;

      for (const [filename, fileData] of entries) {
        try {
          const bytes = new Uint8Array(fileData.content);

          const transferData = {
            filename,
            mime: fileData.mime || 'application/octet-stream',
            bytes: bytes.buffer, // Transfer ArrayBuffer
            size: bytes.length
          };

          results.push({
            name: filename,
            success: true,
            data: transferData
          });

        } catch (error) {
          results.push({
            name: filename,
            success: false,
            error: error.message
          });
        }

        completed++;

        self.postMessage({
          type: 'progress',
          operationId,
          completed,
          total: entries.length,
          current: filename
        });
      }

    } catch (error) {
      throw new Error(`Archive processing failed: ${error.message}`);
    }

    return results;
  }
}

const bulkWorker = new BulkWorker();

self.onmessage = async (e) => {
  const { id, type, data, operationId } = e.data;

  try {
    let result;

    switch (type) {
      case 'import':
        result = await bulkWorker.importFiles(data.files, operationId);
        break;

      case 'export':
        result = await bulkWorker.exportFiles(data.fileData, operationId);
        break;

      case 'process-archive':
        result = await bulkWorker.processArchive(data.arrayBuffer, operationId);
        break;

      default:
        throw new Error(`Unknown bulk operation: ${type}`);
    }

    // Determine transferable objects
    const transferable = [];
    if (Array.isArray(result)) {
      result.forEach(item => {
        if (item.data?.bytes instanceof ArrayBuffer) {
          transferable.push(item.data.bytes);
        }
      });
    } else if (typeof result === 'object') {
      Object.values(result).forEach(item => {
        if (item?.bytes instanceof ArrayBuffer) {
          transferable.push(item.bytes);
        }
      });
    }

    self.postMessage({
      id,
      success: true,
      result,
      operationId
    }, transferable);

  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error.message,
      operationId
    });
  }
};