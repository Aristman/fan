const path = require('path');
const fs = require('fs');
const { createJiti } = require('/home/aristman/projects/fan/node_modules/.bun/jiti@2.6.1/node_modules/jiti');

const typeboxEntry = require.resolve('@sinclair/typebox');
const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, '');
const packagesRoot = path.resolve('/home/aristman/projects/fan/packages');

const alias = {
  '@itone/fan-coding-agent': path.resolve(packagesRoot, 'coding-agent/dist/index.js'),
  '@itone/fan-agent-core': path.resolve(packagesRoot, 'agent/dist/index.js'),
  '@itone/fan-tui': path.resolve(packagesRoot, 'tui/dist/index.js'),
  '@itone/fan-ai': path.resolve(packagesRoot, 'ai/dist/index.js'),
  '@itone/fan-ai/oauth': path.resolve(packagesRoot, 'ai/dist/oauth.js'),
  '@sinclair/typebox': typeboxRoot,
};

const results = [];
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      console.log(`✅ ${name}`);
    } catch (err) {
      results.push({ name, status: 'FAIL', error: err.message });
      console.log(`❌ ${name}: ${err.message}`);
    }
  })();
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

(async () => {
  console.log('=== SOFA Extension Full Test Suite ===\n');

  // Test 1: Module loading
  await test('Extension loads without errors', async () => {
    const jiti = createJiti(__filename, { interopDefault: true, alias });
    const mod = await jiti.import('/home/aristman/.fan/agent/extensions/stack-overflow-agents/index.ts');
    assert(typeof (mod.default || mod) === 'function', 'Factory is not a function');
  });

  // Test 2: Tool registration
  let mockPi;
  await test('All 10 tools and /sofa command register', async () => {
    const jiti = createJiti(__filename, { interopDefault: true, alias });
    const mod = await jiti.import('/home/aristman/.fan/agent/extensions/stack-overflow-agents/index.ts');
    const factory = mod.default || mod;

    mockPi = {
      tools: [],
      commands: {},
      handlers: {},
      on(event, handler) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(handler);
      },
      registerTool(tool) { this.tools.push(tool); },
      registerCommand(name, options) { this.commands[name] = options; }
    };

    await factory(mockPi);

    const expectedTools = [
      'sofa_search', 'sofa_get_post', 'sofa_list_tags', 'sofa_fetch_guidelines',
      'sofa_leaderboard', 'sofa_create_post', 'sofa_reply', 'sofa_vote',
      'sofa_verify', 'sofa_delete_post'
    ];
    const toolNames = mockPi.tools.map(t => t.name);
    for (const t of expectedTools) {
      assert(toolNames.includes(t), `Missing tool: ${t}`);
    }
    assert(mockPi.commands['sofa'], 'Missing /sofa command');
  });

  // Test 3: Lifecycle handlers
  await test('Lifecycle handlers register (session_start, session_shutdown, before_agent_start)', async () => {
    assert(mockPi.handlers['session_start'], 'No session_start handler');
    assert(mockPi.handlers['session_shutdown'], 'No session_shutdown handler');
    assert(mockPi.handlers['before_agent_start'], 'No before_agent_start handler');
  });

  // Test 4: session_start loads config
  await test('session_start initializes without crash', async () => {
    for (const h of mockPi.handlers['session_start']) await h();
  });

  // Test 5: before_agent_start injects SOFA hint for code-research
  await test('before_agent_start injects SOFA hint for relevant skills', async () => {
    const result = await mockPi.handlers['before_agent_start'][0]({
      prompt: '/skill:code-research analyze this',
      systemPrompt: 'base prompt'
    });
    assert(result && result.systemPrompt.includes('Stack Overflow for Agents'), 'SOFA hint not injected');
  });

  // Test 6: before_agent_start does not inject for unrelated prompts
  await test('before_agent_start skips unrelated prompts', async () => {
    const result = await mockPi.handlers['before_agent_start'][0]({
      prompt: 'just a regular message',
      systemPrompt: 'base prompt'
    });
    assert(!result || !result.systemPrompt.includes('Stack Overflow for Agents'), 'SOFA hint injected unexpectedly');
  });

  // Test 7: Tool execute - create_post tag validation
  await test('sofa_create_post rejects tags > 50 chars', async () => {
    const tool = mockPi.tools.find(t => t.name === 'sofa_create_post');
    const result = await tool.execute('test-1', {
      content_type: 'til',
      title: 'Test',
      body: 'Body',
      tags: ['x'.repeat(51)]
    });
    assert(result.isError === true, 'Should return error');
    assert(result.content[0].text.includes('50'), 'Error message should mention 50 char limit');
  });

  // Test 8: Tool execute - vote read-first guard
  await test('sofa_vote enforces read-first guard', async () => {
    const tool = mockPi.tools.find(t => t.name === 'sofa_vote');
    const result = await tool.execute('test-2', { post_id: 'post-123', value: 1 });
    assert(result.isError === true, 'Should return error');
    assert(result.content[0].text.includes('sofa_get_post'), 'Should suggest sofa_get_post');
  });

  // Test 9: Tool execute - verify read-first guard
  await test('sofa_verify enforces read-first guard', async () => {
    const tool = mockPi.tools.find(t => t.name === 'sofa_verify');
    const result = await tool.execute('test-3', {
      post_id: 'post-123',
      outcome: 'worked_as_written',
      feedback: 'test feedback'
    });
    assert(result.isError === true, 'Should return error');
    assert(result.content[0].text.includes('sofa_get_post'), 'Should suggest sofa_get_post');
  });

  // Test 10: Client module loads
  let clientMod;
  await test('Client module loads', async () => {
    const jiti = createJiti(__filename, { interopDefault: true, alias });
    clientMod = await jiti.import('/home/aristman/.fan/agent/extensions/stack-overflow-agents/client.ts');
    assert(clientMod.SofaSessionManager, 'SofaSessionManager not exported');
  });

  // Test 11: Client with mocked fetch
  await test('Client creates session, reads post, votes', async () => {
    const { SofaSessionManager } = clientMod;
    const client = new SofaSessionManager({
      apiKey: 'test-key',
      baseUrl: 'https://agents.stackoverflow.com',
      clientName: 'test-agent',
      modelName: 'test-model'
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url.toString().includes('/api/sessions') && options?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ session_id: 'sess-1', expires_at: new Date(Date.now() + 3600000).toISOString() }) };
      }
      if (url.toString().includes('/api/posts/post-123')) {
        return { ok: true, status: 200, json: async () => ({ id: 'post-123', content_type: 'til', title: 'Test', body: 'Body', tags: ['test'], trust_summary: { score: 80, status: 'trusted' }, view_count: 5, created_at: new Date().toISOString(), replies: [] }) };
      }
      if (url.toString().includes('/api/votes')) {
        return { ok: true, status: 201, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    };

    try {
      const sid = await client.createSession();
      assert(sid === 'sess-1', 'Session ID mismatch');

      const post = await client.getPost('post-123');
      assert(post.title === 'Test', 'Post title mismatch');
      assert(client.hasRead('post-123'), 'Post not marked as read');

      await client.createVote('post-123', 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 12: Command handlers
  await test('/sofa help command works', async () => {
    const cmd = mockPi.commands['sofa'];
    let notified = false;
    const ctx = {
      ui: { notify: () => { notified = true; } },
      waitForIdle: async () => {},
      newSession: async () => {},
      fork: async () => {},
      switchSession: async () => {},
      reload: async () => {}
    };
    await cmd.handler('help', ctx);
    assert(notified, 'Help command did not notify');
  });

  // Test 13: Store publication check
  await test('Package exists in FAN Store index v1.1.0', async () => {
    const index = JSON.parse(fs.readFileSync('/home/aristman/fan-store/index.json', 'utf8'));
    const ext = index.packages.find(p => p.name === 'stack-overflow-agents' && p.version === '1.1.0');
    const skill = index.packages.find(p => p.name === 'stack-overflow-agents-skill' && p.version === '1.1.0');
    assert(ext && ext.type === 'extension', 'Extension v1.1.0 not found');
    assert(skill && skill.type === 'skill', 'Skill v1.1.0 not found');
  });

  // Summary
  console.log('\n=== Test Summary ===');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total: ${results.length} | ✅ PASS: ${passed} | ❌ FAIL: ${failed}`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
})();
