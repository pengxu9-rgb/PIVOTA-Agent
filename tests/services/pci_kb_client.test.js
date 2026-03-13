describe('pciKbClient', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...envBackup };
  });

  test('uses dedicated KB database only when PCI_KB_DATABASE_URL differs from DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://main-db';
    process.env.PCI_KB_DATABASE_URL = 'postgresql://kb-db';

    const client = require('../../src/services/pciKbClient');
    expect(client.getKbDatabaseUrl()).toBe('postgresql://kb-db');
    expect(client.isDedicatedKbConfigured()).toBe(true);
  });

  test('falls back to main DB path when no dedicated KB database is configured', () => {
    process.env.DATABASE_URL = 'postgresql://main-db';
    delete process.env.PCI_KB_DATABASE_URL;

    const client = require('../../src/services/pciKbClient');
    expect(client.getKbDatabaseUrl()).toBe('');
    expect(client.isDedicatedKbConfigured()).toBe(false);
  });
});
