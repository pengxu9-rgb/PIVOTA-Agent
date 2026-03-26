const Busboy = require('busboy');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function rmrf(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function parseMultipart(
  req,
  { maxBytes, allowedContentTypes, requiredFields = [], parseTimeoutMs = 30000 },
) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivota-multipart-'));
    const fields = {};
    const files = {};
    let totalBytes = 0;
    let finished = false;
    let busboyFinished = false;
    let pendingFileWrites = 0;
    const normalizedParseTimeoutMs = Math.max(
      100,
      Math.min(120000, Number(parseTimeoutMs) || 30000),
    );
    let parseTimeout = null;

    function cleanup() {
      if (parseTimeout) {
        clearTimeout(parseTimeout);
        parseTimeout = null;
      }
      req.off('aborted', onReqAborted);
      req.off('error', onReqError);
    }

    function fail(err, statusCode = 400, code = 'INVALID_MULTIPART') {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        req.unpipe(busboy);
      } catch {
        // ignore
      }
      try {
        busboy.destroy();
      } catch {
        // ignore
      }
      rmrf(tmpDir);
      const wrapped = new Error(err?.message || String(err));
      wrapped.statusCode = statusCode;
      wrapped.code = code;
      reject(wrapped);
    }

    function maybeResolve() {
      if (finished || !busboyFinished) return;
      if (pendingFileWrites > 0) return;

      finished = true;
      cleanup();

      for (const field of requiredFields) {
        if (!fields[field]) {
          rmrf(tmpDir);
          const err = new Error(`MISSING_FIELD:${field}`);
          err.statusCode = 400;
          err.code = 'MISSING_FIELD';
          return reject(err);
        }
      }

      return resolve({ fields, files, tmpDir });
    }

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes } });
    parseTimeout = setTimeout(() => {
      fail(new Error('MULTIPART_PARSE_TIMEOUT'), 408, 'MULTIPART_PARSE_TIMEOUT');
    }, normalizedParseTimeoutMs);

    function onReqAborted() {
      fail(new Error('REQUEST_ABORTED'), 499, 'REQUEST_ABORTED');
    }

    function onReqError(err) {
      fail(err || new Error('REQUEST_STREAM_ERROR'), 400, 'INVALID_MULTIPART');
    }

    req.on('aborted', onReqAborted);
    req.on('error', onReqError);

    busboy.on('field', (name, val) => {
      fields[String(name)] = String(val);
    });

    busboy.on('file', (name, stream, info) => {
      const field = String(name);
      const filename = String(info?.filename || '');
      const mimeType = String(info?.mimeType || '').toLowerCase();

      if (!allowedContentTypes.has(mimeType)) {
        stream.resume();
        return fail(
          new Error(`UNSUPPORTED_CONTENT_TYPE:${mimeType}`),
          400,
          'UNSUPPORTED_CONTENT_TYPE',
        );
      }

      const id = randomUUID();
      const outPath = path.join(tmpDir, `${field}-${id}`);
      ensureDir(tmpDir);
      const out = fs.createWriteStream(outPath);
      pendingFileWrites += 1;
      let writeSettled = false;

      function settleWriteState() {
        if (writeSettled) return false;
        writeSettled = true;
        pendingFileWrites = Math.max(0, pendingFileWrites - 1);
        return true;
      }

      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          stream.unpipe(out);
          out.end();
          stream.resume();
          fail(new Error('UPLOAD_TOO_LARGE'), 400, 'UPLOAD_TOO_LARGE');
        }
      });

      stream.on('limit', () => {
        fail(new Error('UPLOAD_TOO_LARGE'), 400, 'UPLOAD_TOO_LARGE');
      });

      const onWriteError = (err) => {
        settleWriteState();
        fail(err || new Error('FILE_WRITE_FAILED'), 400, 'INVALID_MULTIPART');
      };

      stream.on('error', onWriteError);
      out.on('error', onWriteError);

      stream.pipe(out);

      out.on('close', () => {
        if (!settleWriteState()) return;
        files[field] = { path: outPath, filename, contentType: mimeType };
        maybeResolve();
      });
    });

    busboy.on('error', (err) => fail(err, 400, 'INVALID_MULTIPART'));

    busboy.on('finish', () => {
      busboyFinished = true;
      maybeResolve();
    });

    req.pipe(busboy);
  });
}

module.exports = {
  parseMultipart,
  rmrf,
};
