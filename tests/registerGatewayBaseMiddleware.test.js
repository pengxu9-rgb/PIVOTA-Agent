const path = require('path');
const express = require('express');
const request = require('supertest');

const { registerGatewayBaseMiddleware } = require('../src/registerGatewayBaseMiddleware');

describe('registerGatewayBaseMiddleware', () => {
  test('preflight advertises PATCH and echoes allowed origin headers', async () => {
    const app = express();
    registerGatewayBaseMiddleware({
      app,
      expressModule: express,
      publicDir: path.join(__dirname, '..', 'public'),
      logger: { info: jest.fn() },
      serviceBuildId: 'build_1',
      serviceName: 'pivota-agent',
    });

    app.get('/echo', (req, res) => res.json({ ok: true }));

    const resp = await request(app)
      .options('/echo')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'content-type,x-trace-id')
      .expect(204);

    expect(String(resp.headers['access-control-allow-methods'] || '')).toMatch(/\bPATCH\b/);
    expect(resp.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(String(resp.headers['access-control-allow-headers'] || '')).toContain('X-Trace-Id');
  });

  test('normal requests receive build headers and finish logging', async () => {
    const app = express();
    const logger = { info: jest.fn() };
    registerGatewayBaseMiddleware({
      app,
      expressModule: express,
      publicDir: path.join(__dirname, '..', 'public'),
      logger,
      serviceGitShaShort: 'abc123',
      serviceBuildId: 'build_2',
      serviceGitBranch: 'main',
      serviceDeploymentId: 'deploy_1',
      serviceName: 'pivota-agent',
    });

    app.get('/echo', (req, res) => res.json({ ok: true }));

    const resp = await request(app).get('/echo').expect(200);

    expect(resp.headers['x-service-commit']).toBe('abc123');
    expect(resp.headers['x-aurora-git-sha']).toBe('abc123');
    expect(resp.headers['x-service-deployment-id']).toBe('deploy_1');
    expect(resp.headers['x-service-branch']).toBe('main');
    expect(resp.headers['x-aurora-build']).toBe('build_2');
    expect(resp.headers['x-service-name']).toBe('pivota-agent');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/echo',
        status: 200,
        build_id: 'build_2',
        service_commit: 'abc123',
      }),
    );
  });
});
