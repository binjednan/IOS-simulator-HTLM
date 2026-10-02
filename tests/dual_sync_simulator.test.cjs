const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'dual_sync_simulator.html'), 'utf8');
let script = html.split('<script>')[1].split('</script>')[0];
script = script.replace(
  /render\(\);\s*\}\)\(\);\s*$/,
  'render(); globalThis.testAPI={validateSession,importProject,shareRecord,syncDevice,changeRecord,resolveConflict,sessionJson,getState:()=>state};})();',
);
const handlers = {};
const nodes = new Map();
const document = {
  querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', hidden: true,
      addEventListener() {}, showModal() {}, close() {},
    });
    return nodes.get(selector);
  },
  addEventListener(type, handler) { handlers[type] = handler; },
};
const values = new Map();
const context = {
  document,
  localStorage: {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  },
  confirm: () => true,
  setTimeout, clearTimeout, Date, Math, JSON, URL, Blob,
};
vm.createContext(context);
vm.runInContext(script, context);
const app = context.testAPI;

const projectA = {appName: 'تطبيق الطلبات', pages: [{id: 'home', title: 'الرئيسية', items: ['طلب أ', 'طلب ب']}]};
const projectB = {appName: 'تطبيق المتابعة', pages: [{id: 'home', title: 'الرئيسية', items: ['متابعة أ', 'متابعة ب']}]};
const sharedRecord = state => Object.values(state.devices[0].records).find(record => record.shared);
const fileInput = (id, value, project) => ({
  id,
  value,
  dataset: {importProject: id === 'project' ? '0' : undefined},
  files: [{size: JSON.stringify(project).length, text: async () => JSON.stringify(project)}],
  matches: selector => id === 'project' && selector === '[data-import-project]',
});

async function run() {
  await handlers.change({target: fileInput('project', 'orders.json', projectA)});
  assert.equal(app.getState().devices[0].projectName, projectA.appName);
  app.importProject(1, projectB, true);
  let state = app.getState();
  const aId = Object.keys(state.devices[0].records)[0];
  const bId = Object.keys(state.devices[1].records)[0];
  assert.notEqual(aId, bId, 'same page and row keys in two apps must not collide');
  assert.equal(state.devices[0].queue.length + state.devices[1].queue.length, 0, 'imported rows remain private');
  app.syncDevice(0, true); app.syncDevice(1, true);
  assert.equal(Object.keys(state.cloud[Object.keys(state.cloud)[0]].records).length, 0);

  app.shareRecord(0, aId); app.syncDevice(0, true); app.syncDevice(1, true);
  state = app.getState();
  assert.equal(state.devices[1].records[aId].title, 'طلب أ');
  assert.equal(state.devices[1].records[Object.keys(state.devices[0].records)[1]], undefined, 'private row must not leak');
  assert.equal(state.devices[0].records[bId], undefined, 'second app private row must not leak');
  app.changeRecord(1, aId, {note: 'تعديل من تطبيق المتابعة'});
  app.syncDevice(1, true); app.syncDevice(0, true);
  assert.equal(app.getState().devices[0].records[aId].note, 'تعديل من تطبيق المتابعة');

  app.changeRecord(0, aId, {note: 'تعديل أول'});
  app.changeRecord(1, aId, {note: 'تعديل ثانٍ'});
  app.syncDevice(0, true); app.syncDevice(1, true);
  assert.equal(app.getState().devices[1].queue[0].conflict, true, 'concurrent edits must conflict');
  app.resolveConflict(1, aId, 'local'); app.syncDevice(1, true); app.syncDevice(0, true);
  assert.equal(app.getState().devices[0].records[aId].note, 'تعديل ثانٍ');

  state = app.getState();
  state.identity.online = false;
  app.changeRecord(1, aId, {status: 'مكتمل'});
  assert.equal(app.syncDevice(1, true), false, 'offline iPhone cannot sync either app');
  assert.equal(state.devices[1].queue.length, 1);
  state.identity.online = true;
  app.syncDevice(1, true); app.syncDevice(0, true);
  assert.equal(state.devices[0].records[aId].status, 'مكتمل');

  const exported = JSON.parse(app.sessionJson());
  assert.equal(exported.devices[0].projectName, projectA.appName);
  assert.equal(exported.devices[1].projectName, projectB.appName);
  assert.equal(exported.identity.account, 'حساب تجريبي واحد');
  const restored = app.validateSession(exported);
  assert.equal(restored.cloud[Object.keys(restored.cloud)[0]].records[aId].status, 'مكتمل');
  await handlers.change({target: fileInput('sessionFile', 'session.json', exported)});
  assert.equal(app.getState().devices[1].projectName, projectB.appName, 'session file input restores both apps');

  const legacy = {
    format: 'dual-sync-simulator/v1',
    devices: [
      {name: 'الجهاز 1', account: 'old', container: 'shared', pages: [], records: {}, queue: []},
      {name: 'الجهاز 2', account: 'other', container: 'shared', pages: [], records: {}, queue: []},
    ],
    cloud: {},
  };
  const migrated = app.validateSession(legacy);
  assert.equal(migrated.format, 'dual-sync-simulator/v2');
  assert.equal(migrated.migrationBlocked, true, 'old session with different accounts must not silently merge');
  console.log('PASS: separate apps, shared records, isolation, bidirectional edits, conflicts, offline sync, JSON import/export, legacy guard');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
