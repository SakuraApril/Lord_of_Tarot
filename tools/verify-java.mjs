/** 临时：验证 Java 服务接口（跑完删除） */
const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'java_verify@example.com';
const PASS = 'Test1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, headers: r.headers, raw: text.slice(0, 120) };
}

(async () => {
  const health = await api('/api/health');
  console.log('① health:', health.status, JSON.stringify(health.json));

  const login = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: EMAIL, password: PASS }),
  });
  console.log('② login:', login.status, login.json?.token ? '拿到 token' : login.raw);
  const token = login.json?.token;
  if (!token) process.exit(1);
  const auth = { Authorization: 'Bearer ' + token };

  const c1 = await api('/api/user/credits', { headers: auth });
  const c2 = await api('/api/user/credits', { headers: auth });
  console.log(`③ credits: ${c1.json?.credits}，鉴权缓存 ${c1.headers.get('x-auth-cache')} → ${c2.headers.get('x-auth-cache')}`);

  const reqId = crypto.randomUUID();
  const cards = [{ nameZh: '愚者', reversed: false }];
  const submit = await api('/api/reading/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth, 'X-Request-Id': reqId },
    body: JSON.stringify({ question: 'Java 版链路测试', cards }),
  });
  console.log('④ 提交:', submit.status, JSON.stringify(submit.json));

  const taskId = submit.json?.taskId;
  let task = null;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const t = await api('/api/reading/task/' + taskId, { headers: auth });
    task = t.json;
    if (task && (task.status === 'done' || task.status === 'failed')) break;
  }
  console.log(`⑤ 任务: ${task?.status}，attempts=${task?.attempts}，内容前 30 字: ${(task?.content || '').slice(0, 30).replace(/\n/g, ' ')}`);

  const replay = await api('/api/reading/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth, 'X-Request-Id': reqId },
    body: JSON.stringify({ question: 'Java 版链路测试', cards }),
  });
  console.log('⑥ 幂等重放:', replay.status, `replayed=${replay.json?.replayed}，taskId 相同=${replay.json?.taskId === taskId}`);

  const after = await api('/api/user/credits', { headers: auth });
  console.log('⑦ 余额: 5 →', after.json?.credits, '（期望 4，只扣一次）');

  const cardsResp = await api('/api/cards');
  console.log('⑧ /api/cards:', cardsResp.status, 'ETag=', cardsResp.headers.get('etag'), '长度', cardsResp.raw.length);

  const out = await api('/api/auth/logout', { method: 'POST', headers: auth });
  console.log('⑨ 登出:', out.status, JSON.stringify(out.json));
  const afterOut = await api('/api/user/credits', { headers: auth });
  console.log('⑩ 登出后同 token:', afterOut.status, JSON.stringify(afterOut.json));

  const pass = health.status === 200
    && login.status === 200
    && c1.headers.get('x-auth-cache') === 'MISS'
    && c2.headers.get('x-auth-cache') === 'HIT'
    && submit.status === 202
    && task?.status === 'done'
    && replay.json?.replayed === true
    && after.json?.credits === 4
    && out.status === 200
    && afterOut.status === 401;
  console.log(pass ? '\n✅ Java 版链路验证通过' : '\n❌ 验证失败');
  process.exit(pass ? 0 : 1);
})();
