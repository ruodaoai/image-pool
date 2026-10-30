const TOKEN = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);
let activeInstallJob = null;
let toastTimer = null;

const fields = {
  installDir: $('installDir'), branch: $('branch'), fpbUrl: $('fpbUrl'), vbUrl: $('vbUrl'),
  port: $('port'), adminUsername: $('adminUsername'), adminPassword: $('adminPassword'),
  apiKey: $('apiKey'), bridgeToken: $('bridgeToken'), vbKey: $('vbKey'),
  model: $('model'), aspectRatio: $('aspectRatio'), prompt: $('prompt'), taskId: $('taskId')
};

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Setup-Token': TOKEN},
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.className = 'toast', 3500);
}

function setBusy(button, busy, busyText = '处理中…') {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function saveNonSensitive() {
  const data = {installDir: fields.installDir.value, branch: fields.branch.value, fpbUrl: fields.fpbUrl.value, vbUrl: fields.vbUrl.value, port: fields.port.value};
  localStorage.setItem('fpb-setup-nonsensitive', JSON.stringify(data));
}

function restoreNonSensitive() {
  try {
    const data = JSON.parse(localStorage.getItem('fpb-setup-nonsensitive') || '{}');
    Object.entries(data).forEach(([key, value]) => { if (fields[key] && value) fields[key].value = value; });
  } catch (_) {}
  syncLinks();
}

function syncLinks() {
  const base = fields.fpbUrl.value.replace(/\/$/, '');
  $('adminLink').href = `${base}/login`;
}

function status(name, ok, detail) {
  const node = document.querySelector(`[data-status="${name}"]`);
  node.classList.toggle('ok', !!ok);
  node.classList.toggle('fail', !ok);
  node.querySelector('b').textContent = detail;
}

async function detect(button = $('detectBtn')) {
  setBusy(button, true, '检测中…');
  saveNonSensitive();
  try {
    const data = await api('/api/detect', {
      install_dir: fields.installDir.value,
      fpb_url: fields.fpbUrl.value,
      vb_url: fields.vbUrl.value
    });
    status('python', data.python, data.python ? '已找到' : '未安装');
    status('git', data.git, data.git ? '已找到' : '未安装');
    status('project', data.project, data.project ? (data.venv ? '项目与依赖环境就绪' : '项目存在，依赖未就绪') : '未安装');
    status('fpb', data.fpb_port_open, data.fpb_port_open ? '端口在线' : '未启动');
    status('vb', data.vb_port_open, data.vb_port_open ? '端口在线' : '未启动');
    toast('环境检测完成');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
}

async function pollInstallJob() {
  if (!activeInstallJob) return;
  try {
    const response = await fetch(`/api/jobs/${activeInstallJob}`);
    const job = await response.json();
    $('installLog').textContent = (job.logs || []).join('\n') || '正在准备…';
    $('installLog').scrollTop = $('installLog').scrollHeight;
    if (job.status === 'running') {
      setTimeout(pollInstallJob, 1200);
    } else {
      setBusy($('installBtn'), false);
      activeInstallJob = null;
      toast(job.status === 'completed' ? '项目安装完成' : `安装失败：${job.error || '请查看日志'}`, job.status !== 'completed');
      detect();
    }
  } catch (error) {
    setBusy($('installBtn'), false);
    toast(error.message, true);
  }
}

$('installBtn').addEventListener('click', async () => {
  setBusy($('installBtn'), true, '安装中…');
  $('installLog').textContent = '正在创建安装任务…';
  try {
    const result = await api('/api/install', {install_dir: fields.installDir.value, branch: fields.branch.value});
    activeInstallJob = result.job_id;
    pollInstallJob();
  } catch (error) { setBusy($('installBtn'), false); toast(error.message, true); }
});

$('generateSecretsBtn').addEventListener('click', async () => {
  setBusy($('generateSecretsBtn'), true, '生成中…');
  try {
    const result = await api('/api/secrets');
    fields.adminPassword.value = result.admin_password;
    fields.apiKey.value = result.api_key;
    fields.bridgeToken.value = result.bridge_token;
    toast('已生成三组随机密钥，请记住后台密码');
  } catch (error) { toast(error.message, true); }
  finally { setBusy($('generateSecretsBtn'), false); }
});

$('configureBtn').addEventListener('click', async () => {
  setBusy($('configureBtn'), true, '写入中…');
  try {
    const result = await api('/api/configure', {
      install_dir: fields.installDir.value,
      port: Number(fields.port.value),
      admin_username: fields.adminUsername.value,
      admin_password: fields.adminPassword.value,
      api_key: fields.apiKey.value,
      bridge_token: fields.bridgeToken.value
    });
    fields.fpbUrl.value = `http://127.0.0.1:${result.port}`;
    syncLinks(); saveNonSensitive();
    toast(result.backup_path ? '配置已写入，旧配置已备份' : '配置已写入');
    detect();
  } catch (error) { toast(error.message, true); }
  finally { setBusy($('configureBtn'), false); }
});

async function service(action, button) {
  setBusy(button, true, '处理中…');
  try {
    const result = await api('/api/service', {install_dir: fields.installDir.value, action});
    $('connectionResult').textContent = result.output || `${action} 完成`;
    toast(`服务操作完成：${action}`);
    setTimeout(() => detect(), 900);
  } catch (error) { $('connectionResult').textContent = error.message; toast(error.message, true); }
  finally { setBusy(button, false); }
}

$('startBtn').addEventListener('click', () => service('start', $('startBtn')));
$('statusBtn').addEventListener('click', () => service('status', $('statusBtn')));
$('stopBtn').addEventListener('click', () => service('stop', $('stopBtn')));

$('testVbBtn').addEventListener('click', async () => {
  setBusy($('testVbBtn'), true, '测试中…');
  try {
    const result = await api('/api/test/virtualbrowser', {vb_url: fields.vbUrl.value, vb_key: fields.vbKey.value});
    $('connectionResult').textContent = JSON.stringify(result, null, 2);
    toast('VirtualBrowser API 连接成功');
  } catch (error) { $('connectionResult').textContent = error.message; toast(error.message, true); }
  finally { setBusy($('testVbBtn'), false); }
});

$('testFpbBtn').addEventListener('click', async () => {
  setBusy($('testFpbBtn'), true, '测试中…');
  try {
    const result = await api('/api/test/fpbrowser', {fpb_url: fields.fpbUrl.value, api_key: fields.apiKey.value});
    $('connectionResult').textContent = JSON.stringify(result, null, 2);
    toast('模型接口连接成功');
  } catch (error) { $('connectionResult').textContent = error.message; toast(error.message, true); }
  finally { setBusy($('testFpbBtn'), false); }
});

$('submitTaskBtn').addEventListener('click', async () => {
  setBusy($('submitTaskBtn'), true, '提交中…');
  try {
    const result = await api('/api/tasks/submit', {
      fpb_url: fields.fpbUrl.value, api_key: fields.apiKey.value,
      model: fields.model.value, aspect_ratio: fields.aspectRatio.value, prompt: fields.prompt.value
    });
    const id = result.task_id || result.id;
    if (id) fields.taskId.value = id;
    $('taskResult').textContent = JSON.stringify(result, null, 2);
    toast('图片任务已提交');
  } catch (error) { $('taskResult').textContent = error.message; toast(error.message, true); }
  finally { setBusy($('submitTaskBtn'), false); }
});

$('checkTaskBtn').addEventListener('click', async () => {
  setBusy($('checkTaskBtn'), true, '查询中…');
  try {
    const result = await api('/api/tasks/status', {
      fpb_url: fields.fpbUrl.value, api_key: fields.apiKey.value, task_id: fields.taskId.value
    });
    $('taskResult').textContent = JSON.stringify(result, null, 2);
    toast(`任务状态：${result.status || result.state || '已返回'}`);
  } catch (error) { $('taskResult').textContent = error.message; toast(error.message, true); }
  finally { setBusy($('checkTaskBtn'), false); }
});

$('detectBtn').addEventListener('click', () => detect($('detectBtn')));
$('detectBottomBtn').addEventListener('click', () => detect($('detectBottomBtn')));
fields.fpbUrl.addEventListener('input', syncLinks);
document.querySelectorAll('.step-link').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.step-link').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  document.getElementById(button.dataset.target).scrollIntoView({behavior: 'smooth', block: 'start'});
}));

restoreNonSensitive();
detect();
