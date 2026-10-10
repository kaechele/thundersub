import test from 'node:test';
import assert from 'node:assert/strict';

let storage = {};
let folders = {};
const fullMessages = new Map();
const getFullCalls = [];
const deletedIds = [];
let nextId = 1;

globalThis.browser = {
  runtime: {
    getManifest: () => ({ name: 'ThunderSub' }),
    onMessage: { addListener() {} },
    sendMessage: async () => {}
  },
  storage: {
    local: {
      get: async keys => {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter(k => k in storage).map(k => [k, structuredClone(storage[k])]));
      },
      set: async values => { Object.assign(storage, structuredClone(values)); },
      remove: async keys => { for (const k of [].concat(keys)) delete storage[k]; }
    }
  },
  accounts: {
    list: async () => [{
      id: 'acct', name: 'Personal', type: 'imap',
      folders: Object.keys(folders).map(id => ({ id, name: id, type: id === 'Inbox' ? 'inbox' : undefined }))
    }]
  },
  identities: { list: async () => [{ email: 'me@example.net' }] },
  folders: {
    getFolderInfo: async id => ({ totalMessageCount: folders[id].length }),
    getSubFolders: async () => []
  },
  messages: {
    list: async folderId => ({ messages: folders[folderId] }),
    continueList: async () => null,
    getFull: async id => { getFullCalls.push(id); return fullMessages.get(id); },
    query: async ({ folderId, headerMessageId }) => ({
      messages: folders[folderId].filter(m => `<${m.headerMessageId}>` === headerMessageId || m.headerMessageId === headerMessageId)
    }),
    delete: async ids => { deletedIds.push(...ids); }
  }
};

const { handleRuntimeMessage } = await import('../background.js');

function message({ from, subject, list, listName, unsubscribe = 'https://lists.example.org/unsub', date = '2026-06-01T00:00:00Z' }) {
  const id = nextId++;
  const headerMessageId = `m${id}@example.org`;
  const headers = {
    from: [from],
    to: ['me@example.net'],
    'message-id': [`<${headerMessageId}>`]
  };
  if (list) {
    headers['list-id'] = [listName ? `${listName} <${list}>` : `<${list}>`];
    headers['list-post'] = [`<mailto:${list.replace('.', '@')}>`];
  }
  if (unsubscribe) headers['list-unsubscribe'] = [`<${unsubscribe}>`];
  fullMessages.set(id, { headers, parts: [{ contentType: 'text/plain', body: 'Hello' }] });
  return { id, author: from, subject, date: new Date(date), headerMessageId };
}

async function scan() {
  await handleRuntimeMessage({ command: 'scan' });
  for (;;) {
    const state = await handleRuntimeMessage({ command: 'getScanStatus' });
    if (state.status !== 'scanning') return state;
    await new Promise(r => setTimeout(r, 5));
  }
}

async function subscriptions() {
  return handleRuntimeMessage({ command: 'getSubscriptions', filter: 'all' });
}

function reset(folderMap) {
  storage = {};
  folders = folderMap;
  getFullCalls.length = 0;
  deletedIds.length = 0;
}

test('groups every poster to a list into one subscription', async () => {
  reset({
    Lists: [
      message({ from: 'Alice <alice@example.com>', subject: 'Release plan', list: 'dev.lists.example.org', listName: 'Dev List' }),
      message({ from: 'bob@example.com', subject: 'Build broken', list: 'dev.lists.example.org', listName: 'Dev List' }),
      message({ from: 'alice@example.com', subject: 'Meeting notes', list: 'dev.lists.example.org', listName: 'Dev List' })
    ]
  });
  await scan();
  const subs = await subscriptions();
  assert.equal(subs.length, 1);
  const [sub] = subs;
  assert.equal(sub.isList, true);
  assert.equal(sub.senderName, 'Dev List');
  assert.equal(sub.senderEmail, 'dev@lists.example.org');
  assert.equal(sub.emailCount, 3);
  assert.deepEqual(sub.listPosters, ['alice@example.com', 'bob@example.com']);
  assert.deepEqual(sub.topPosters, [
    { address: 'alice@example.com', count: 2 },
    { address: 'bob@example.com', count: 1 }
  ]);
});

test('keeps each list\'s unsubscribe methods separate for a poster on several lists', async () => {
  reset({
    Lists: [
      message({ from: 'alice@example.com', subject: 'A', list: 'one.example.org', unsubscribe: 'https://one.example.org/unsub', date: '2026-06-01T00:00:00Z' }),
      message({ from: 'alice@example.com', subject: 'B', list: 'two.example.org', unsubscribe: 'https://two.example.org/unsub', date: '2026-06-02T00:00:00Z' })
    ]
  });
  await scan();
  const subs = await subscriptions();
  const byList = Object.fromEntries(subs.map(s => [s.listId, s.unsubUrls]));
  assert.deepEqual(byList, {
    'one.example.org': ['https://one.example.org/unsub'],
    'two.example.org': ['https://two.example.org/unsub']
  });
  assert.equal(subs.find(s => s.listId === 'one.example.org').senderName, 'one.example.org');
});

test('counts replies on discussion lists and ignores them elsewhere', async () => {
  const listReply = message({ from: 'carol@example.com', subject: 'Re: Release plan', list: 'dev.lists.example.org' });
  const personalReply = message({ from: 'friend@example.com', subject: 'Re: dinner', unsubscribe: '' });
  reset({
    Lists: [
      message({ from: 'alice@example.com', subject: 'Release plan', list: 'dev.lists.example.org' }),
      message({ from: 'bob@example.com', subject: 'Build broken', list: 'dev.lists.example.org' }),
      listReply
    ],
    Inbox: [
      message({ from: 'news@shop.example', subject: 'Sale', list: 'news.shop.example' }),
      personalReply
    ]
  });
  await scan();
  const subs = await subscriptions();
  const dev = subs.find(s => s.listId === 'dev.lists.example.org');
  assert.equal(dev.emailCount, 3);
  assert.ok(dev.listPosters.includes('carol@example.com'));
  assert.ok(getFullCalls.includes(listReply.id));
  assert.ok(!getFullCalls.includes(personalReply.id), 'replies in folders without a discussion list are not fetched');
});

test('moves a decision from a pre-grouping sender card to its list card', async () => {
  reset({
    Lists: [
      message({ from: 'alice@example.com', subject: 'A', list: 'dev.lists.example.org' }),
      message({ from: 'bob@example.com', subject: 'B', list: 'dev.lists.example.org' })
    ]
  });
  storage.subscriptions = [{
    subscriptionKey: JSON.stringify(['alice@example.com', 'me@example.net', 'me@example.net']),
    senderEmail: 'alice@example.com',
    recipientAddress: 'me@example.net',
    accountIdentityAddress: 'me@example.net',
    listId: 'dev.lists.example.org',
    decision: 'unsubscribed',
    dispose: 'delete',
    messageGroups: []
  }];
  await scan();
  const subs = await subscriptions();
  assert.equal(subs.length, 1, 'the old sender card is replaced, not kept alongside');
  assert.equal(subs[0].isList, true);
  assert.equal(subs[0].decision, 'unsubscribed');
  assert.equal(subs[0].dispose, 'delete');
});

test('cleanup acts on every poster\'s messages but nothing outside the list', async () => {
  const alice = message({ from: 'alice@example.com', subject: 'A', list: 'dev.lists.example.org' });
  const bob = message({ from: 'bob@example.com', subject: 'B', list: 'dev.lists.example.org' });
  reset({ Lists: [alice, bob] });
  await scan();
  const [sub] = await subscriptions();

  // A message from outside the list that forged a colliding Message-ID.
  folders.Lists.push({ id: 999, author: 'victim@example.com', subject: 'Private', headerMessageId: alice.headerMessageId });

  const result = await handleRuntimeMessage({
    command: 'deleteEmails',
    subscriptionKey: sub.subscriptionKey,
    senderEmail: sub.senderEmail,
    recipientAddress: sub.recipientAddress,
    messageGroups: sub.messageGroups.map(g => ({ ...g, sessionId: 'previous-session' }))
  });
  assert.equal(result.deleted, 2);
  assert.deepEqual(deletedIds.sort(), [alice.id, bob.id].sort());
});
