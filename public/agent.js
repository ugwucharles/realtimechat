(() => {
  const socket = io();
  const qs = (s) => document.querySelector(s);
  const byId = (id) => document.getElementById(id);

  const agentNameEl = byId('agentName');
  const goOnlineBtn = byId('goOnline');
  const agentStatusDot = byId('agentStatusDot');

  const convList = byId('convList');
  const search = byId('search');
  const fAll = byId('fAll');
  const fMine = byId('fMine');
  const fUnassigned = byId('fUnassigned');
  const statusSelect = byId('statusSelect');

  const chatTitle = byId('chatTitle');
  const chatChannel = byId('chatChannel');
  const messagesEl = byId('messages');
  const composer = byId('composer');
  const msgInput = byId('msgInput');
  const claimBtn = byId('claimBtn');
  const closeBtn = byId('closeBtn');

  let agent = null;
  const notifBadge = document.getElementById('notifBadge');
  let conversations = [];
  let currentConv = null;

  // filters
  let assignedFilter = 'all'; // all | mine | unassigned
  let statusFilter = 'open';

  // load logged-in user
  (async function initUser(){
    try {
      const r = await fetch('/me');
      if (!r.ok) { window.location.href = '/login'; return; }
      const me = await r.json();
      agentNameEl.value = me.name || 'Agent';
    } catch { window.location.href = '/login'; }
  })();

  function escapeHtml(s){
    return String(s||'')
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }

  function fmtTime(iso){ try { const d=new Date(iso); return d.toLocaleTimeString(); } catch { return '' } }
  function relTime(iso){
    try {
      const d = new Date(iso); const now = Date.now();
      const diff = Math.max(0, Math.floor((now - d.getTime())/1000));
      if (diff < 60) return `${diff}s`;
      if (diff < 3600) return `${Math.floor(diff/60)}m`;
      if (diff < 86400) return `${Math.floor(diff/3600)}h`;
      return `${Math.floor(diff/86400)}d`;
    } catch { return ''; }
  }
  function channelChip(name){
    const n = String(name||'').toLowerCase();
    const label = n || 'web';
    const color = n==='whatsapp' ? '#22c55e' : n==='telegram' ? '#60a5fa' : n==='outlook' ? '#f59e0b' : n==='facebook' ? '#60a5fa' : n==='instagram' ? '#f472b6' : '#94a3b8';
    return `<span class="chip" style="border-color:${color}55; color:${color}">${label}</span>`;
  }

  function bubble(msg){
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.sender === 'agent' ? 'agent' : 'customer');
    const who = msg.sender === 'agent' ? 'Agent' : 'Customer';
    const ts = msg.created_at ? fmtTime(msg.created_at) : '';
    div.innerHTML = `<span class="meta">${who} • ${ts}</span>${escapeHtml(msg.content || '')}`;
    return div;
  }

  function renderMessages(list){
    messagesEl.innerHTML = '';
    list.forEach(m => messagesEl.appendChild(bubble(m)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderConversations(){
    const q = search.value.trim().toLowerCase();
    convList.innerHTML = '';
    for (const c of conversations){
      if (q && !(String(c.customer_name||'').toLowerCase().includes(q))) continue;
      const li = document.createElement('li');
      li.className = 'conv'+(currentConv && currentConv.id===c.id?' active':'');
      const who = c.last_sender === 'agent' ? 'You' : 'Customer';
      const accent = c.last_sender === 'agent' ? '#60a5fa' : '#fca5a5';
      li.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; width:100%">
          <div style="flex:1 1 auto; min-width:0">
            <div class="name" style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(c.customer_name)}</div>
            <div class="meta" style="font-size:12px; color:#9aa4b2;">${who} • <span style="color:${accent}">${escapeHtml(c.last_sender||'customer')}</span></div>
          </div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px">
            ${channelChip(c.channel_name)}
            <div class="time" style="font-size:12px; color:#9aa4b2">${relTime(c.last_activity_at)}</div>
          </div>
        </div>`;
      li.addEventListener('click', () => openConversation(c.id));
      convList.appendChild(li);
    }
  }

  async function loadConversations(){
    const url = new URL('/conversations', window.location.origin);
    if (statusFilter !== 'all') url.searchParams.set('status', statusFilter);
    url.searchParams.set('limit','100');
    if (assignedFilter === 'unassigned') url.searchParams.set('assignedTo', 'null');
    if (assignedFilter === 'mine' && agent?.id) url.searchParams.set('assignedTo', String(agent.id));
    try {
      const res = await fetch(url);
      const data = await res.json();
      conversations = data;
      renderConversations();
    } catch (e) { console.error('loadConversations', e); }
  }

  async function openConversation(id){
    try {
      const c = conversations.find(x=>x.id===id);
      currentConv = c || { id };
      chatTitle.textContent = c ? c.customer_name : `Conversation #${id}`;
      chatChannel.textContent = c?.channel_name || '';
      claimBtn.disabled = !c || !!c.assigned_agent_id;
      closeBtn.disabled = !c;

      socket.emit('conversation:join', { conversationId: id });
      const res = await fetch(`/messages?conversationId=${id}`);
      const msgs = await res.json();
      renderMessages(msgs);
    } catch (e) { console.error('openConversation', e); }
  }

  async function claimCurrent(){
    if (!currentConv || !agent) return;
    try {
      const res = await fetch(`/conversations/${currentConv.id}/claim`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ agentName: agent.name }) });
      if (res.ok){
        const conv = await res.json();
        const idx = conversations.findIndex(x=>x.id===conv.id);
        if (idx>=0) conversations[idx] = conv;
        claimBtn.disabled = true;
        renderConversations();
      }
    } catch (e) { console.error('claim', e); }
  }

  async function closeCurrent(){
    if (!currentConv) return;
    try {
      const res = await fetch(`/conversations/${currentConv.id}/status`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status:'closed' }) });
      if (res.ok){
        conversations = conversations.filter(x=>x.id!==currentConv.id);
        currentConv = null; chatTitle.textContent = 'No conversation selected'; messagesEl.innerHTML='';
        renderConversations();
      }
    } catch (e) { console.error('close', e); }
  }

  // events
  goOnlineBtn.addEventListener('click', () => {
    const name = agentNameEl.value.trim() || 'Agent';
    socket.emit('agent:register', { name });
  });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!currentConv) return;
    const text = msgInput.value.trim(); if (!text) return;
    const username = (agent?.name || 'Agent');
    socket.emit('conversation:message', { conversationId: currentConv.id, sender:'agent', username, content: text });
    msgInput.value=''; msgInput.focus();
  });
  // Send on Enter (but allow Shift+Enter for newline)
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  claimBtn.addEventListener('click', claimCurrent);
  closeBtn.addEventListener('click', closeCurrent);
  search.addEventListener('input', renderConversations);
  const logoutBtn = document.getElementById('logoutBtn');
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/auth/logout', { method:'POST' }); } finally { window.location.href = '/login'; }
  });

  // filter events
  fAll.addEventListener('click', () => { assignedFilter='all'; loadConversations(); highlightAssign(); });
  fMine.addEventListener('click', () => { assignedFilter='mine'; loadConversations(); highlightAssign(); });
  fUnassigned.addEventListener('click', () => { assignedFilter='unassigned'; loadConversations(); highlightAssign(); });
  statusSelect.addEventListener('change', () => { statusFilter = statusSelect.value; loadConversations(); });
  function highlightAssign(){
    fAll.classList.toggle('active', assignedFilter==='all');
    fMine.classList.toggle('active', assignedFilter==='mine');
    fUnassigned.classList.toggle('active', assignedFilter==='unassigned');
  }

  // socket hooks
  socket.on('agent:registered', (payload) => {
    agent = payload.agent;
    if (agentStatusDot){ agentStatusDot.classList.remove('offline'); agentStatusDot.classList.add('online'); agentStatusDot.title = 'Online'; }
    loadConversations();
    loadAnalytics();
  });

  socket.on('agent:conversations', (list) => {
    conversations = list; renderConversations();
  });

  socket.on('conversation:assigned', (conv) => {
    // add or update
    const idx = conversations.findIndex(x=>x.id===conv.id);
    if (idx>=0) conversations[idx] = Object.assign(conversations[idx], conv);
    else conversations.unshift(conv);
    renderConversations();
  });

  socket.on('inbox:update', () => { loadConversations(); loadAnalytics(); });

  socket.on('conversation:message', (msg) => {
    if (!currentConv || msg.conversation_id !== currentConv.id) return;
    messagesEl.appendChild(bubble(msg)); messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  async function loadAnalytics(){
    try {
      const r = await fetch('/analytics/summary');
      if (!r.ok) return;
      const a = await r.json();
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
      set('aOpen', a.totalOpen || 0);
      set('aUnassigned', a.unassignedOpen || 0);
      set('aOnline', a.onlineAgents || 0);
      set('aMsgs', a.messages24h || 0);
      if (notifBadge){
        const n = Number(a.notificationsUnread || 0);
        notifBadge.textContent = String(n);
        notifBadge.hidden = !(n > 0);
      }
    } catch {}
  }

  // initial
  loadConversations();
  loadAnalytics();
})();

