const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const fs = require('fs');
const { PassThrough, Writable } = require('stream');

const { parseMultipart } = require('../src/lookReplicator/multipart');

test('parseMultipart fails fast when request never finishes', async () => {
  const req = new PassThrough();
  req.headers = { 'content-type': 'multipart/form-data; boundary=----aurora-timeout' };

  await assert.rejects(
    parseMultipart(req, {
      maxBytes: 1024,
      parseTimeoutMs: 120,
      allowedContentTypes: new Set(['image/jpeg']),
      requiredFields: ['slot_id'],
    }),
    (err) => {
      assert.equal(err.code, 'MULTIPART_PARSE_TIMEOUT');
      assert.equal(err.statusCode, 408);
      return true;
    },
  );

  req.destroy();
});

test('parseMultipart surfaces file write errors without hanging', async () => {
  const app = express();
  app.post('/upload', async (req, res) => {
    try {
      await parseMultipart(req, {
        maxBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        allowedContentTypes: new Set(['image/jpeg']),
        requiredFields: ['slot_id', 'consent'],
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ code: err.code || 'UNKNOWN' });
    }
  });

  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = () =>
    new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });

  try {
    const response = await supertest(app)
      .post('/upload')
      .field('slot_id', 'daylight')
      .field('consent', 'true')
      .attach('photo', Buffer.from([0xff, 0xd8, 0xff]), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_MULTIPART');
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
  }
});
