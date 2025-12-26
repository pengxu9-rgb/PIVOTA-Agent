const Busboy = require('busboy');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function parseMultipart(req, { maxBytes, allowedContentTypes, requiredFields = [] }) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookrep-'));
    const fields = {};
    const files = {};
    let totalBytes = 0;
    let finished = false;
    let busboyFinished = false;
    let pendingFileWrites = 0;

    function fail(err, statusCode = 400, code = 'INVALID_MULTIPART') {
      if (finished) return;
      finished = true;
      rmrf(tmpDir);
      const e = new Error(err?.message || String(err));
      e.statusCode = statusCode;
      e.code = code;
      reject(e);
    }

    function maybeResolve() {
      if (finished || !busboyFinished) return;
      if (pendingFileWrites > 0) return;

      finished = true;

      for (const f of requiredFields) {
        if (!fields[f]) {
          rmrf(tmpDir);
          const e = new Error(`MISSING_FIELD:${f}`);
          e.statusCode = 400;
          e.code = 'MISSING_FIELD';
          return reject(e);
        }
      }

      return resolve({ fields, files, tmpDir });
    }

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes } });

    busboy.on('field', (name, val) => {
      fields[String(name)] = String(val);
    });

    busboy.on('file', (name, stream, info) => {
      const field = String(name);
      const filename = String(info?.filename || '');
      const mimeType = String(info?.mimeType || '').toLowerCase();

      if (!allowedContentTypes.has(mimeType)) {
        stream.resume();
        return fail(new Error(`UNSUPPORTED_CONTENT_TYPE:${mimeType}`), 400, 'UNSUPPORTED_CONTENT_TYPE');
      }

      const id = randomUUID();
      const outPath = path.join(tmpDir, `${field}-${id}`);
      ensureDir(tmpDir);
      const out = fs.createWriteStream(outPath);
      pendingFileWrites += 1;

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

      stream.pipe(out);

      out.on('close', () => {
        files[field] = { path: outPath, filename, contentType: mimeType };
        pendingFileWrites -= 1;
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
