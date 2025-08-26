(() => {
  const socket = io();
  const $ = (s) => document.querySelector(s);
  const nameEl = $('#custName');
  const startBtn = $('#startBtn');
  const agentBadge = $('#agentBadge');
  const messagesEl = $('#messages');
  const composer = $('#composer');
  const input = $('#msgInput');

  let convo = null;

  function escapeHtml(s){
    return String(s||'')
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }
  function fmtTime(iso){ try { const d=new Date(iso); return d.toLocaleTimeString(); } catch { return '' } }

  function bubble(msg){
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.sender === 'agent' ? 'agent' : 'customer');
    const who = msg.sender === 'agent' ? (msg.username||'Agent') : 'You';
    const ts = msg.created_at ? fmtTime(msg.created_at) : '';
    div.innerHTML = `<span class=meta>${who} • ${ts}</span>${escapeHtml(msg.content||'')}`;
    return div;
  }

  startBtn.addEventListener('click', () => {
    const name = nameEl.value.trim() || 'Customer';
    socket.emit('customer:start', { name });
  });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!convo) return;
    const text = input.value.trim(); if (!text) return;
    socket.emit('conversation:message', { conversationId: convo.id, sender:'customer', username: (nameEl.value||'Customer'), content: text });
    input.value=''; input.focus();
  });

  socket.on('conversation:started', (payload) => {
    convo = payload.conversation;
    const ag = payload.assignedAgent;
    agentBadge.textContent = ag ? `Agent: ${ag.name}` : 'Waiting for agent...';
    input.disabled = false; composer.querySelector('button').disabled = false;
    socket.emit('conversation:join', { conversationId: convo.id });
  });

  socket.on('conversation:agent', ({ conversationId, agent }) => {
    if (!convo || conversationId !== convo.id) return;
    agentBadge.textContent = agent ? `Agent: ${agent.name}` : 'Waiting for agent...';
  });

  socket.on('conversation:message', (msg) => {
    if (!convo || msg.conversation_id !== convo.id) return;
    messagesEl.appendChild(bubble(msg)); messagesEl.scrollTop = messagesEl.scrollHeight;
  });
})();

