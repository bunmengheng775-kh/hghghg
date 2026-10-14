const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = { pdf: '📄', video: '🎬', html: '🌐', image: '🖼️', other: '📁' };
const S = { user: null, files: [], exercises: [], users: [], sel: null, selectedExerciseId: null, msg: '', userMsg: '' };
let installPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('appinstalled', () => { installPrompt = null; });

function bindInstallButton() {
  const button = $('#install');
  if (!button) return;
  button.onclick = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      return;
    }
    const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    alert(isAppleMobile
      ? 'In Safari, tap Share, then Add to Home Screen.'
      : 'Open your browser menu and choose Install app or Add to Home screen.');
  };
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.error('Service worker registration failed:', e));
  }
  if (API.token) { try { S.user = await API.me(); await load(); } catch (e) { API.token = ''; } }
  render();
  setInterval(() => S.user && load().then(() => {
    refreshList();
    renderExerciseList();
    if (!API.demoMode && ['teacher', 'owner'].includes(S.user.role) && S.selectedExerciseId) renderViewer();
  }).catch(() => {}), 8000);
}
async function load() {
  [S.files, S.exercises] = await Promise.all([API.files(), API.exercises()]);
}

function render() { S.user ? renderMain() : renderLogin(); }

function renderLogin() {
  $('#app').innerHTML = `<form class="card login" id="login-form">
    <h1 style="margin:0">📚 Study Hub</h1>
    <label for="u">Username</label>
    <input type="text" id="u" name="username" placeholder="Username" autocomplete="username" required>
    <label for="p">Password</label>
    <div class="password-field"><input type="password" id="p" name="password" placeholder="Password" autocomplete="current-password" required><button class="btn g password-toggle" id="toggle-password" type="button" aria-label="Show password" aria-pressed="false">Show</button></div>
    <label for="role">Role</label>
    <select id="role" name="role" required>
      <option value="student">Student</option>
      <option value="teacher">Teacher</option>
      <option value="owner" selected>Owner</option>
    </select>
    <button class="btn" id="go" type="submit">Log in</button><button class="btn g" id="install" type="button">Add to Home Screen</button><div class="mu" id="lm" role="status" aria-live="polite"></div></form>`;
  bindInstallButton();
  $('#toggle-password').onclick = () => {
    const password = $('#p'), button = $('#toggle-password');
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} password`);
    button.setAttribute('aria-pressed', String(show));
  };
  const go = async event => {
    event.preventDefault();
    const button = $('#go'), message = $('#lm');
    button.disabled = true;
    message.textContent = 'Signing in…';
    try { S.user = await API.login($('#u').value.trim().toLowerCase(), $('#p').value, $('#role').value); await load(); render(); }
    catch (e) { message.textContent = e.message; button.disabled = false; }
  };
  $('#login-form').addEventListener('submit', go);
}

function renderMain() {
  const t = !API.demoMode && ['teacher', 'owner'].includes(S.user.role);
  const isOwner = !API.demoMode && S.user.role === 'owner';
  const roleName = API.demoMode ? `Demo · ${S.user.role}` : isOwner ? 'Owner' : t ? 'Teacher' : 'Student';
  $('#app').innerHTML = `<header><h1>📚 Study Hub</h1><span class="mu">${esc(S.user.name)} · ${roleName}</span><button class="btn g" id="install">Add to Home Screen</button><button class="btn g" id="lo">Log out</button></header>
  ${API.demoMode ? '<div class="demo-notice" role="status"><b>Local demo only</b> · Accounts and passwords are not saved or verified. To save users securely and share data, open the deployed Study Hub server.</div>' : ''}
  <div class="wrap"><div>
    ${t ? `<div class="card" style="margin-bottom:12px"><div class="drop" id="dz">Drop files or photos here or <label style="color:var(--ac);cursor:pointer">browse<input type="file" id="fi" multiple hidden></label></div><div class="mu" id="um">${esc(S.msg)}</div></div>
      <section class="card exercise-create"><h2>Create an exercise</h2>
        <form id="exercise-form" class="user-form">
          <label>Title<input name="title" maxlength="120" required></label>
          <label>Instructions<textarea name="instructions" maxlength="2000" rows="3"></textarea></label>
          <label>Questions (one per line)<textarea name="questions" rows="5" required placeholder="Write each question on a separate line"></textarea></label>
          <button class="btn" type="submit">Publish exercise</button>
        </form>
        <div id="exercise-status" class="mu" role="status" aria-live="polite"></div>
      </section>` : ''}
    <div class="card"><b>Materials</b><div id="list" style="margin-top:8px"></div></div>
    <section class="card exercise-list-card"><b>Exercises</b><div id="exercise-list" style="margin-top:8px"></div></section>
    ${isOwner ? `<section class="card account-admin"><h2>Manage users</h2><p class="mu">Create student or teacher accounts and change their access.</p>
      <form id="user-form" class="user-form">
        <label>Username<input name="username" autocomplete="off" minlength="3" maxlength="32" required></label>
        <label>Display name<input name="name" autocomplete="off" maxlength="80" required></label>
        <label>Temporary password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
        <label>Permission<select name="role"><option value="student">Student — view materials</option><option value="teacher">Teacher — manage materials</option></select></label>
        <button class="btn" type="submit">Create account</button>
      </form>
      <div id="user-status" class="mu" role="status" aria-live="polite">${esc(S.userMsg)}</div>
      <div id="user-list" class="user-list"><span class="mu">Loading accounts…</span></div>
    </section>` : ''}
  </div><div class="card viewer" id="vw"></div></div>`;
  bindInstallButton();
  $('#lo').onclick = async () => { await API.logout(); S.user = null; render(); };
  if (isOwner) {
    $('#user-form').addEventListener('submit', createUser);
    loadUsers().catch(e => { $('#user-list').textContent = e.message; });
  }
  if (t) $('#exercise-form').addEventListener('submit', createExercise);
  if (t) {
    const dz = $('#dz'), up = async fl => { $('#um').textContent = 'Uploading…'; try { await API.upload(fl); await load(); S.msg = 'Uploaded ✓'; } catch (e) { S.msg = e.message; } renderMain(); };
    $('#fi').onchange = e => up(e.target.files);
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('h'); }; dz.ondragleave = () => dz.classList.remove('h');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('h'); up(e.dataTransfer.files); };
  }
  refreshList(); renderExerciseList(); renderViewer();
}

async function loadUsers() {
  S.users = await API.users();
  renderUsers();
}

function renderUsers() {
  const list = $('#user-list');
  if (!list) return;
  list.innerHTML = `<div class="user-rows">${S.users.map(user => `<div class="user-row">
    <div class="user-identity"><b>${esc(user.name)}</b><span class="mu">${esc(user.username)}</span></div>
    <div class="user-actions">
      <label class="user-role">Permission<select data-user="${esc(user.username)}" ${user.role === 'owner' ? 'disabled' : ''}>
        <option value="student" ${user.role === 'student' ? 'selected' : ''}>Student</option>
        <option value="teacher" ${user.role === 'teacher' ? 'selected' : ''}>Teacher</option>
        ${user.role === 'owner' ? '<option value="owner" selected>Owner</option>' : ''}
      </select></label>
      ${user.role === 'owner' ? '' : `<button class="btn r delete-user" type="button" data-delete-user="${esc(user.username)}">Delete</button>`}
    </div>
  </div>`).join('')}</div>`;
  list.querySelectorAll('select[data-user]').forEach(select => {
    select.onchange = async () => {
      const status = $('#user-status');
      select.disabled = true;
      status.textContent = 'Updating permission…';
      try {
        await API.updateUser(select.dataset.user, { role: select.value });
        S.userMsg = 'Permission updated.';
        await loadUsers();
        status.textContent = S.userMsg;
      } catch (e) {
        status.textContent = e.message;
        await loadUsers();
      }
    };
  });
  list.querySelectorAll('button[data-delete-user]').forEach(button => {
    button.onclick = async () => {
      const username = button.dataset.deleteUser;
      const user = S.users.find(account => account.username === username);
      if (!user || !confirm(`Delete the account "${user.name}" (@${username})? They will lose access immediately.`)) return;
      const status = $('#user-status');
      button.disabled = true;
      status.textContent = 'Deleting account…';
      try {
        await API.deleteUser(username);
        S.userMsg = `Deleted account ${username}.`;
        await loadUsers();
        status.textContent = S.userMsg;
      } catch (e) {
        status.textContent = e.message;
        button.disabled = false;
      }
    };
  });
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget, status = $('#user-status');
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  button.disabled = true;
  status.textContent = 'Creating account…';
  try {
    await API.createUser(values);
    form.reset();
    S.userMsg = 'Account created.';
    status.textContent = S.userMsg;
    await loadUsers();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

async function createExercise(event) {
  event.preventDefault();
  const form = event.currentTarget, status = $('#exercise-status');
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  const exercise = {
    title: values.title,
    instructions: values.instructions,
    questions: values.questions.split(/\r?\n/).map(question => question.trim()).filter(Boolean)
  };
  button.disabled = true;
  status.textContent = 'Publishing exercise…';
  try {
    const created = await API.createExercise(exercise);
    form.reset();
    S.selectedExerciseId = created.id;
    S.sel = null;
    await load();
    status.textContent = 'Exercise published.';
    renderExerciseList();
    renderViewer();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

function renderExerciseList() {
  const list = $('#exercise-list');
  if (!list) return;
  list.innerHTML = S.exercises.map(exercise => `<button class="exercise-item ${exercise.id === S.selectedExerciseId ? 'on' : ''}" type="button" data-exercise="${esc(exercise.id)}">
    <span class="exercise-title">${esc(exercise.title)}</span>
    <span class="mu">${exercise.questions.length} question${exercise.questions.length === 1 ? '' : 's'}${Array.isArray(exercise.submissions) ? ` · ${exercise.submissions.length} submitted` : exercise.mySubmission ? ' · Submitted' : ''}</span>
  </button>`).join('') || '<div class="mu">No exercises yet.</div>';
  list.querySelectorAll('[data-exercise]').forEach(button => {
    button.onclick = () => {
      S.selectedExerciseId = button.dataset.exercise;
      S.sel = null;
      renderExerciseList();
      renderListSelection();
      renderViewer();
    };
  });
}

function renderListSelection() {
  const list = $('#list');
  if (!list) return;
  list.querySelectorAll('.item').forEach(item => item.classList.toggle('on', item.dataset.id === S.sel));
}

function refreshList() {
  const el = $('#list'); if (!el) return; const t = !API.demoMode && ['teacher', 'owner'].includes(S.user.role);
  el.innerHTML = S.files.map(f => `<div class="item ${f.id === S.sel ? 'on' : ''}" data-id="${f.id}">
    <span>${ICON[f.kind] || '📁'}</span><span class="t">${esc(f.name)}</span>
    ${t ? `<button class="btn g s" data-a="rn" title="Rename">✏️</button><button class="btn g s" data-a="cp" title="Caption">${f.caption ? '💬✓' : '💬'}</button>` : ''}</div>`).join('') || '<div class="mu">No files yet.</div>';
  el.querySelectorAll('.item').forEach(i => i.onclick = () => {
    S.sel = i.dataset.id; S.selectedExerciseId = null;
    refreshList(); renderExerciseList(); renderViewer();
  });
  el.querySelectorAll('.item button').forEach(b => b.onclick = e => { e.stopPropagation(); edit(b.closest('.item').dataset.id, b.dataset.a); });
}

async function edit(id, what) {
  const f = S.files.find(x => x.id === id); if (!f) return;
  let patch;
  if (what === 'rn') { const n = prompt('New file name', f.name); if (!n || !n.trim()) return; patch = { name: n }; }
  else { const c = prompt('Caption (empty = remove)', f.caption || ''); if (c === null) return; patch = { caption: c }; }
  try { await API.update(id, patch); await load(); refreshList(); renderViewer(); } catch (e) { alert(e.message); }
}

function renderViewer() {
  const vw = $('#vw'), exercise = S.exercises.find(item => item.id === S.selectedExerciseId);
  if (exercise) {
    const teacherMode = !API.demoMode && ['teacher', 'owner'].includes(S.user.role);
    const content = `<h3>Student submissions</h3>${exercise.submissions.length
        ? exercise.submissions.map(submission => `<article class="submission"><b>${esc(submission.name)} <span class="mu">(@${esc(submission.username)})</span></b>
          ${submission.answers.map((answer, index) => `<p><b>${index + 1}. ${esc(exercise.questions[index])}</b><br>${esc(answer).replace(/\n/g, '<br>')}</p>`).join('')}
          <span class="mu">Submitted ${new Date(submission.updatedAt || submission.at).toLocaleString()}</span></article>`).join('')
        : '<p class="mu">No student submissions yet.</p>'}`;
    vw.innerHTML = `<div class="row"><h2 class="exercise-heading">${esc(exercise.title)}</h2>${teacherMode ? '<button class="btn r" id="delete-exercise" type="button">Delete</button>' : ''}</div>
      ${exercise.instructions ? `<p class="caption">${esc(exercise.instructions)}</p>` : ''}
      ${teacherMode ? content : `<form id="answers-form" class="answers-form">${exercise.questions.map((question, index) => `<label class="answer-question"><b>${index + 1}. ${esc(question)}</b><textarea data-answer rows="3" maxlength="5000" required>${esc(exercise.mySubmission ? exercise.mySubmission.answers[index] : '')}</textarea></label>`).join('')}<button class="btn" type="submit">${exercise.mySubmission ? 'Update answers' : 'Submit answers'}</button><div id="answer-status" class="mu" role="status" aria-live="polite">${exercise.mySubmission ? 'Your answers are saved. You can edit and resubmit them.' : ''}</div></form>`}`;
    if (teacherMode) {
      $('#delete-exercise').onclick = async () => {
        if (!confirm(`Delete exercise "${exercise.title}" and its submissions?`)) return;
        try {
          await API.deleteExercise(exercise.id);
          S.selectedExerciseId = null;
          await load();
          renderExerciseList();
          renderViewer();
        } catch (e) { alert(e.message); }
      };
    } else {
      $('#answers-form').onsubmit = async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        const status = $('#answer-status');
        button.disabled = true;
        status.textContent = 'Submitting answers…';
        try {
          await API.submitExercise(exercise.id, [...event.currentTarget.querySelectorAll('[data-answer]')].map(input => input.value));
          await load();
          renderExerciseList();
          renderViewer();
        } catch (e) {
          status.textContent = e.message;
          button.disabled = false;
        }
      };
    }
    return;
  }
  const f = S.files.find(x => x.id === S.sel);
  if (!f) { vw.innerHTML = '<div class="mu">Select a file or exercise to open it.</div>'; return; }
  const t = !API.demoMode && ['teacher', 'owner'].includes(S.user.role), u = API.rawUrl(f.id);
  const body = f.kind === 'html' ? `<iframe sandbox="allow-scripts allow-forms allow-modals" src="${u}"></iframe>`
    : f.kind === 'image' ? `<img src="${u}" alt="${esc(f.name)}">`
    : f.kind === 'video' ? `<video controls src="${u}"></video>`
    : f.kind === 'pdf' ? `<embed type="application/pdf" src="${u}">`
    : `<a href="${u}" target="_blank" rel="noopener">Download ${esc(f.name)}</a>`;
  vw.innerHTML = `<div class="row"><b style="flex:1">${esc(f.name)}</b>${t ? `<button class="btn g" id="rn">Rename</button><button class="btn g" id="cp">${f.caption ? 'Edit caption' : 'Add caption'}</button><button class="btn r" id="dl">Delete</button>` : ''}</div>
    ${body}${f.caption ? `<div class="caption">${esc(f.caption)}</div>` : ''}`;
  if (t) {
    $('#rn').onclick = () => edit(f.id, 'rn'); $('#cp').onclick = () => edit(f.id, 'cp');
    $('#dl').onclick = async () => { if (!confirm('Delete ' + f.name + '?')) return; try { await API.remove(f.id); S.sel = null; await load(); refreshList(); renderViewer(); } catch (e) { alert(e.message); } };
  }
}
init();
