import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';

const $ = (s) => document.querySelector(s);
const axes = {specificity:'具体性', support:'裏付け', uncertainty:'確定度', relevance:'重要性', structure:'構成', clarity:'明瞭さ'};
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const markdown = (s) => DOMPurify.sanitize(marked.parse(s || ''), {FORBID_TAGS:['img']});
let results = [], selected = new Set(), view = 'overview', busy = false, config = null;
let currentRun = null, models = [], pollTimer = null, loadVersion = 0, appendMode = false, submitting = false, deleting = false, criteriaDirty = false, savingCriteria = false;

const mergeSelection=new Set();
let merging=false;
const PROMPT_STORAGE_KEY='draft-jev-prompts-v1';
const defaultPrompt='元情報をもとに、一般のビジネス読者に向けた解説記事を日本語のMarkdownで書いてください。何が変わるのか、誰にどのような影響があるのかを具体的に説明してください。';
function promptEntries() { return [...document.querySelectorAll('.prompt')].map(el=>({text:el.querySelector('textarea').value,enabled:el.querySelector('.prompt-enabled').checked})); }
function prompts() { return promptEntries().map(p=>p.text.trim()); }
function allocation() { return promptEntries().map(p=>p.enabled ? Number($('#count').value) : 0); }
function updateAllocation() {
  const entries=promptEntries(), counts=allocation(); let start=appendMode && currentRun ? currentRun.next_candidate_id : 1;
  $('#allocation').textContent=`合計 ${counts.reduce((sum,n)=>sum+n,0)}件 · `+counts.map((n,i)=>{
    const from=start; start+=n;
    return entries[i].enabled ? `P${i+1}: ${n}件（#${from}〜${start-1}）` : `P${i+1}: 無効`;
  }).join(' / ');
  $('#add').disabled=appendMode || entries.length>=10;
  document.querySelectorAll('.prompt').forEach((el,i)=>{
    el.querySelector('.prompt-title').textContent=`P${i+1}`;
    el.querySelector('.remove').disabled=appendMode || entries.length===1;
    el.querySelector('.prompt-enabled').disabled=appendMode;
    el.querySelector('textarea').readOnly=appendMode;
    el.querySelector('textarea').disabled=!entries[i].enabled;
    el.classList.toggle('prompt-inactive',!entries[i].enabled);
  });
}
function savePrompts() {
  if(appendMode) return;
  try { localStorage.setItem(PROMPT_STORAGE_KEY,JSON.stringify(promptEntries())); $('#prompt-storage').textContent='本文・有効状態をこのブラウザに保存しました。'; }
  catch { $('#prompt-storage').textContent='ブラウザに保存できませんでした。ストレージ設定を確認してください。'; }
}
function addPrompt(value='', enabled=true) {
  const el=document.createElement('div'); el.className='prompt';
  el.innerHTML=`<div class="row start"><strong class="prompt-title"></strong><label><input type="checkbox" class="prompt-enabled"> 有効</label><button type="button" class="remove" aria-label="このプロンプトを削除">削除</button></div><textarea rows="4" required maxlength="12000" placeholder="文章の目的、読者、長さ、語り口など"></textarea>`;
  el.querySelector('textarea').value=value; el.querySelector('.prompt-enabled').checked=enabled;
  el.querySelector('.remove').onclick=()=>{el.remove();updateAllocation();savePrompts();};
  el.querySelector('.prompt-enabled').onchange=()=>{updateAllocation();savePrompts();};
  el.querySelector('textarea').oninput=savePrompts;
  $('#prompts').append(el); updateAllocation();
}
function restorePrompts() {
  let entries=[{text:defaultPrompt,enabled:true}], message='このブラウザには保存済みのプロンプトがありません。';
  try {
    const raw=localStorage.getItem(PROMPT_STORAGE_KEY);
    if(raw) {
      const saved=JSON.parse(raw);
      if(!Array.isArray(saved) || !saved.length || saved.length>10 || saved.some(p=>typeof p.text!=='string' || typeof p.enabled!=='boolean')) throw new Error();
      entries=saved; message='ブラウザに保存した本文・有効状態を復元しました。';
    }
  } catch { message='保存済みプロンプトを読み込めませんでした。'; }
  $('#prompts').innerHTML=''; entries.forEach(p=>addPrompt(p.text,p.enabled));
  $('#prompt-storage').textContent=message;
}
$('#add').onclick=()=>{addPrompt();savePrompts();};
$('#count').oninput=updateAllocation;
$('#restore-prompts').onclick=()=>{setAppendMode(false);restorePrompts();};
restorePrompts();

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  let data;
  try { data = await response.json(); } catch { throw new Error('サーバーから正常な応答がありません。'); }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '入力が長すぎるか、形式が正しくありません。');
  return data;
}
function favoriteButton(r) { return `<button type="button" class="best-button ${r.favorite ? 'is-best' : ''}" data-favorite="${r.id}" aria-pressed="${!!r.favorite}" ${!r.text ? 'disabled' : ''}>${r.favorite ? '★ お気に入り' : '☆ お気に入り'}</button>`; }
function autoBestBadge(r) { return r.auto_best ? `<span class="badge auto-best">${busy ? '暫定ベスト' : 'ベスト'}</span>` : ''; }
function effortLabel(r) { return r.requested_effort == null ? '未指定（旧結果）' : r.requested_effort === 'default' ? '未指定（モデル既定）' : r.requested_effort; }
function usd(value) { return Number(value).toFixed(9).replace(/0+$/,'').replace(/\.$/,'')+' USD'; }
function costLabel(costs) {
  if(!costs) return '未記録';
  return costs.total == null ? `確認済み ${usd(costs.known_total)}（${costs.unknown}件の料金不明）` : usd(costs.total);
}
function costDetails(costs) {
  if(!costs) return '費用未記録';
  return `生成 ${usd(costs.generation)} / Jev ${usd(costs.evaluation)} / 合計 ${costLabel(costs)}`;
}
function generationDetails(r) {
  const m=r.generation_metadata;
  const tokens=m?.usage?.completion_tokens_details?.reasoning_tokens;
  return `<p class="hint">費用: ${escape(costDetails(r.costs))}</p><details class="generation-details"><summary>生成条件 · Effort ${escape(effortLabel(r))}</summary><p>送信Effort: ${escape(effortLabel(r))}<br>適用済みEffortのAPI報告: ${escape(m?.reported_effort || '確認不可（返却なし）')}<br>プロバイダー: ${escape(m?.provider || '未取得')}<br>Reasoning tokens: ${tokens == null ? '未取得' : escape(tokens)}</p><p class="hint">同じEffort名でもモデル間で計算量が同じとは限りません。旧結果の値は推定していません。</p>${m ? `<pre>${escape(JSON.stringify(m,null,2))}</pre>` : '<p>この結果には生成条件の詳細記録がありません。</p>'}</details>`;
}
function badge(r) {
  if (!r.evaluation) return `<span class="badge ${r.error ? 'bad' : ''}">${escape(r.status)}</span>`;
  return `<span class="badge ${r.evaluation.ng ? 'bad' : 'good'}">${r.evaluation.ng ? 'NG' : 'OK'}</span>`;
}
function bar(value, max = 3, label = '') {
  return `<span class="bar" aria-label="${escape(label)} ${value} / ${max}"><i style="width:${Math.max(0, Math.min(100, value/max*100))}%"></i></span><span class="number">${max === 100 ? value.toFixed(1) : value.toFixed(2)}</span>`;
}
function selectBox(r) { return `<input type="checkbox" data-select="${r.id}" aria-label="候補${r.id}を比較対象にする" ${selected.has(r.id) ? 'checked' : ''}>`; }
function overview() {
  return `<p class="hint">比較する候補にチェックを入れ、「文章を比較」または「評価を比較」を選んでください。各軸は0〜3点。重大な問題の確率が0.3以上ならNGです。</p><div class="table-scroll"><table><thead><tr><th>比較</th><th>候補 / モデル / 指示</th><th>判定</th><th>総合 / 100</th>${Object.values(axes).map(a=>`<th>${a}</th>`).join('')}<th>本文プレビュー</th></tr></thead><tbody>${results.map(r=>`<tr><td>${selectBox(r)}<br>${favoriteButton(r)}<br>${autoBestBadge(r)}</td><td><strong>#${r.id}</strong><br><span class="tag">P${r.promptId}</span><small class="candidate-model">${escape(r.requested_model || r.model || currentRun?.model)}</small><small>Effort ${escape(effortLabel(r))}</small><small>生成 ${r.batch || 1}回目</small><small>${escape(costLabel(r.costs))}</small></td><td>${badge(r)}${r.evaluation ? `<small>問題 ${r.evaluation.raw.answers.suspicious.noul.toFixed(3)}</small>` : ''}</td><td>${r.evaluation ? bar(r.evaluation.total,100,'総合') : '—'}</td>${Object.keys(axes).map(a=>`<td>${r.evaluation ? bar(r.evaluation.raw.answers[a].score,3,axes[a]) : '—'}</td>`).join('')}<td class="preview">${r.error ? `<span class="error">${escape(r.error)}</span>` : ''}<div class="excerpt">${r.text ? markdown(r.text) : escape(r.status)}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function evaluationDetails(r) {
  if (!r.evaluation) return `<p>${escape(r.error || r.status)}</p>`;
  const e = r.evaluation, answers = e.raw.answers;
  return `<div class="total"><strong>${e.total.toFixed(1)}</strong> / 100 ${badge(r)}</div>
  <div class="metric"><div class="row"><strong>重大な問題の確率</strong><b>${answers.suspicious.noul.toFixed(3)}</b></div><div class="risk-bar"><i style="width:${answers.suspicious.noul*100}%"></i><span></span></div><small>0.3未満でOK（低いほどよい）</small></div>
  ${Object.entries(axes).map(([key,label])=>{
    const a = answers[key], q = currentRun?.questions[key] || config?.questions[key];
    return `<section class="metric"><div class="row"><strong>${label}</strong><b>${a.score.toFixed(2)} / 3</b></div>${bar(a.score,3,label)}<div class="hint">confidence: ${typeof a.confidence === 'number' ? a.confidence.toFixed(3) : '—'}</div><div class="probabilities">${[0,1,2,3].map(level=>`<div title="${escape(a.legend?.[level] || q?.criteria[level] || '')}"><span>${level}点</span><meter min="0" max="1" value="${a.probabilities?.[level] ?? 0}"></meter><small>${typeof a.probabilities?.[level] === 'number' ? (a.probabilities[level]*100).toFixed(1)+'%' : '—'}</small></div>`).join('')}</div><details><summary>評価基準</summary><p>${escape(q?.instructions)}</p><ol start="0">${(q?.criteria || []).map(c=>`<li>${escape(c)}</li>`).join('')}</ol></details></section>`;
  }).join('')}<details><summary>重大な問題の判定基準</summary><p>${escape((currentRun?.questions || config?.questions)?.suspicious.instructions)}</p><pre>${escape(JSON.stringify((currentRun?.questions || config?.questions)?.suspicious.criteria,null,2))}</pre></details><details><summary>Jevの生の結果</summary><pre>${escape(JSON.stringify(e.raw,null,2))}</pre></details>`;
}
function comparison() {
  const rows = results.filter(r=>selected.has(r.id));
  if (!rows.length) return '<div class="empty">比較する候補を上のチェックボックスで選んでください。</div>';
  return `<div class="comparison">${rows.map(r=>`<article class="candidate"><div class="candidate-heading"><h2>#${r.id} <span class="tag">P${r.promptId}</span></h2>${favoriteButton(r)}${autoBestBadge(r)}${badge(r)}${r.evaluation ? `<strong>${r.evaluation.total.toFixed(1)}点</strong>` : ''}</div><p class="hint">生成モデル: ${escape(r.model || r.requested_model || currentRun?.model)} · 生成 ${r.batch || 1}回目${r.created ? ` · ${new Date(r.created).toLocaleString('ja-JP')}` : ''}</p>${generationDetails(r)}${r.origin_run_id ? `<p class="hint">マージ元: ${escape(r.origin_run_id)} / #${r.origin_candidate_id}</p>` : ''}<details class="used-prompt"><summary>使用したプロンプト P${r.promptId}</summary><p>${escape(r.prompt)}</p></details>${view === 'text' ? `${r.error ? `<p class="error">${escape(r.error)}</p>` : ''}<div class="markdown">${r.text ? markdown(r.text) : escape(r.status)}</div>` : evaluationDetails(r)}</article>`).join('')}</div>`;
}
function render() {
  $('#progress').textContent = results.length ? `${results.filter(r=>['完了','生成失敗','評価失敗','中断'].includes(r.status)).length} / ${results.length}件 処理済み${busy ? ' · 実行中' : ''}` : 'まだ生成していません';
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view === view));
  $('#selection').innerHTML = results.length && view !== 'overview' ? `<div class="selection">${results.map(r=>`<label>${selectBox(r)} #${r.id} <strong class="selection-score">${r.evaluation ? r.evaluation.total.toFixed(1)+'点' : '未評価'}</strong> <span class="tag">P${r.promptId}</span> ${autoBestBadge(r)}</label>`).join('')}</div>` : '';
  $('#run-info').textContent = currentRun ? `${currentRun.name} · ${new Date(currentRun.created).toLocaleString('ja-JP')} · ${[...new Set(results.map(r=>r.requested_model || currentRun.model))].join(' / ')} · ${currentRun.status}（自動保存）` : '';
  $('#run-cost').textContent=currentRun ? `API費用（削除済み・マージ元の費用を含む）: ${costDetails(currentRun.costs)}` : '';
  $('#append-mode').hidden=!currentRun;
  $('#append-mode').disabled=busy || submitting;
  $('#append-hint').textContent=currentRun ? '元情報とプロンプトを固定して、この一覧へ候補を追加します。' : '';
  const bestRows=results.filter(r=>r.auto_best);
  $('#auto-best-info').textContent=currentRun ? (bestRows.length ? `${busy ? '暫定ベスト' : 'ベスト'}（OK候補内の最高総合点）: ${bestRows.map(r=>'#'+r.id).join(', ')} · ${bestRows[0].evaluation.total.toFixed(1)}点` : 'ベストなし（評価済みのOK候補がありません）') : '';
  updateDeleteButton();
  $('#results').innerHTML = results.length ? (view === 'overview' ? overview() : comparison()) : `<div class="empty">${currentRun ? '候補はありません。「別モデルで追加生成」から追加できます。' : '元情報とプロンプトを入力して、候補を生成してください。'}</div>`;
}
document.addEventListener('change', event=>{
  if (event.target.matches('[data-select]')) {
    const id = Number(event.target.dataset.select);
    event.target.checked ? selected.add(id) : selected.delete(id);
    updateDeleteButton();
    if (view !== 'overview') render();
  }
});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view; render();});

function updateEffort(preferred) {
  const model=models.find(m=>m.id===$('#generation-model').value);
  if(!model) return;
  const reasoning=model.reasoning || {};
  let levels=Object.hasOwn(reasoning,'supported_efforts') ? (reasoning.supported_efforts ?? ['none','minimal','low','medium','high','xhigh','max']) : [];
  if(reasoning.mandatory) levels=levels.filter(level=>level!=='none');
  const select=$('#effort'), prior=preferred ?? (select.dataset.initialized ? select.value : (levels.includes('medium') ? 'medium' : 'default'));
  select.innerHTML='<option value="">Effortを選択</option><option value="default">未指定（モデル既定に従う）</option>'+levels.map(level=>`<option value="${escape(level)}">${escape(level)}</option>`).join('');
  select.value=prior==='default' || levels.includes(prior) ? prior : '';
  select.dataset.initialized='true';
  $('#effort-info').textContent=levels.length ? `対応Effort: ${levels.join(' / ')} · モデル既定: ${reasoning.default_effort || '未公開'}。指定値を各候補に記録します。` : 'このモデルはEffort選択の対応情報がありません。「未指定」で実行し、その事実を記録します。';
  if(!select.value) $('#effort-info').textContent+=' 以前の指定値に非対応のため、選び直してください。';
}
const price = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? '$'+(Number(value)*1000000).toLocaleString('en-US',{maximumFractionDigits:6}) : '—';
function modelInfo() {
  const model = models.find(m=>m.id === $('#generation-model').value);
  if (!model) { $('#model-info').textContent='利用可能なモデルを選択してください。'; return; }
  updateEffort();
  $('#model-info').textContent=`100万トークン当たり 入力 ${price(model.pricing?.prompt)} / 出力 ${price(model.pricing?.completion)} · コンテキスト ${model.context_length?.toLocaleString() ?? '—'} tokens（長文等の追加料金を除く）`;
}
function renderModels(preferred) {
  const previous = preferred || $('#generation-model').value || config?.generation_model;
  const query = $('#model-search').value.trim().toLowerCase();
  const matched = models.filter(m=>`${m.name} ${m.id}`.toLowerCase().includes(query) || m.id === previous);
  $('#generation-model').innerHTML = '<option value="">生成モデルを選択</option>' + matched.map(m=>`<option value="${escape(m.id)}">${escape(m.name)} · 入力 ${price(m.pricing?.prompt)} / 出力 ${price(m.pricing?.completion)} — ${escape(m.id)}</option>`).join('');
  if (matched.some(m=>m.id === previous)) $('#generation-model').value=previous;
  modelInfo();
}
async function loadModels() {
  $('#reload-models').disabled=true;
  try { models=await api('/api/models'); renderModels(); }
  catch(error) { $('#model-info').textContent=error.message; }
  finally { $('#reload-models').disabled=false; }
}
$('#model-search').oninput=()=>renderModels();
$('#generation-model').onchange=modelInfo;
$('#reload-models').onclick=loadModels;

document.addEventListener('change',event=>{
  if(!event.target.matches('[data-merge]')) return;
  const id=event.target.dataset.merge;
  event.target.checked ? mergeSelection.add(id) : mergeSelection.delete(id);
  $('#merge-runs').disabled=merging || mergeSelection.size<2;
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-rename]');
  if(!button) return;
  const id=button.dataset.rename, input=document.querySelector(`[data-run-name="${id}"]`);
  const name=input.value.trim();
  if(!name) { $('#history-message').textContent='実行名を入力してください。'; input.focus(); return; }
  button.disabled=true;
  try {
    const saved=await api(`/api/runs/${id}/rename`,{name});
    input.value=saved.name;
    if(currentRun?.id===id) { currentRun.name=saved.name; $('#run-name').value=saved.name; if(appendMode) setAppendMode(true); render(); }
    $('#history-message').textContent='実行名を変更しました。';
  } catch(error) { $('#history-message').textContent=error.message; }
  finally { button.disabled=false; }
});
$('#merge-runs').onclick=async()=>{
  if(merging || mergeSelection.size<2) return;
  merging=true; $('#merge-runs').disabled=true;
  $('#history-message').textContent='実行条件を照合しています。';
  try {
    const run=await api('/api/runs/merge',{run_ids:[...mergeSelection]});
    mergeSelection.clear(); await openRun(run.id); await loadHistory();
    $('#history-message').textContent='マージした履歴を作成しました。元の履歴も保持しています。';
  } catch(error) { $('#history-message').textContent=error.message; }
  finally { merging=false; $('#merge-runs').disabled=mergeSelection.size<2; }
};

async function loadHistory() {
  try {
    const history=await api('/api/runs?favorite_only='+$('#favorite-only').checked);
    const visible=new Set(history.filter(r=>r.status !== '実行中').map(r=>r.id));
    for(const id of mergeSelection) if(!visible.has(id)) mergeSelection.delete(id);
    $('#merge-runs').disabled=merging || mergeSelection.size<2;
    $('#history').innerHTML=history.length ? `<div class="table-scroll"><table class="history-table"><thead><tr><th>マージ</th><th>実行名 / 日時</th><th>モデル</th><th>状態</th><th>最高点</th><th>費用（USD）</th><th>お気に入り</th><th></th></tr></thead><tbody>${history.map(r=>`<tr><td><input type="checkbox" data-merge="${r.id}" aria-label="${escape(r.name)}をマージ対象にする" ${mergeSelection.has(r.id) ? 'checked' : ''} ${r.status === '実行中' ? 'disabled' : ''}></td><td><div class="row start"><input data-run-name="${r.id}" value="${escape(r.name)}" maxlength="120" aria-label="実行名"><button type="button" data-rename="${r.id}">名前を保存</button></div><small>${new Date(r.created).toLocaleString('ja-JP')}</small></td><td>${escape(r.models || r.model)}</td><td>${escape(r.status)} · ${r.count}件</td><td>${r.top_score == null ? '—' : r.top_score.toFixed(1)}</td><td class="cost-cell">${escape(costLabel(r.costs))}</td><td>★ ${r.favorite_count}</td><td><button data-open="${r.id}">開く</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">該当する履歴はありません。</p>';
  } catch(error) { $('#history').textContent=error.message; }
}
$('#favorite-only').onchange=loadHistory;
$('#refresh-history').onclick=loadHistory;

function displayRun(run, restoreInput=false, bestOnly=false) {
  currentRun=run; results=run.results; busy=run.status === '実行中';
  $('#inputs').disabled=busy || submitting;
  if (restoreInput) {
    $('#source').value=run.source;
    $('#run-name').value=run.name;
    $('#prompts').innerHTML='';
    run.prompts.forEach((p,i)=>addPrompt(p,run.prompt_enabled[i]));
    $('#count').value=1;
    $('#model-search').value='';
    renderModels(run.results.at(-1)?.requested_model || run.model);
    updateEffort(run.results.at(-1)?.requested_effort || 'default');
    setAppendMode(false);
    $('#prompt-storage').textContent='履歴のプロンプトを表示中です。ブラウザ保存分には戻すボタンで戻れます。';
    const best=results.filter(r=>r.favorite);
    selected=new Set((bestOnly && best.length ? best : results.slice(0,2)).map(r=>r.id));
    view=bestOnly ? 'text' : 'overview';
    $('#setup').open=false;
  }
  render();
}
async function openRun(id, bestOnly=false, restoreInput=true) {
  clearTimeout(pollTimer);
  const version=++loadVersion;
  try {
    const run=await api('/api/runs/'+encodeURIComponent(id));
    if (version !== loadVersion) return;
    displayRun(run,restoreInput,bestOnly);
    window.history.replaceState(null,'','#'+id);
    $('#message').textContent=busy ? '実行中です。画面を閉じても処理と保存は続きます。' : '保存した実行結果を開きました。';
    if (busy) schedulePoll(id,version);
  } catch(error) { $('#message').textContent=error.message; }
}
function schedulePoll(id, version) {
  pollTimer=setTimeout(async()=>{
    try {
      const run=await api('/api/runs/'+encodeURIComponent(id));
      if (version !== loadVersion) return;
      displayRun(run);
      if (busy) schedulePoll(id,version);
      else { $('#message').textContent='処理が終了し、結果を保存しました。'; await loadHistory(); }
    } catch(error) {
      if (version !== loadVersion) return;
      $('#message').textContent=error.message+' 状態を再取得します。';
      schedulePoll(id,version);
    }
  },1500);
}
document.addEventListener('click',async event=>{
  const open=event.target.closest('[data-open]');
  if (open) { await openRun(open.dataset.open,$('#favorite-only').checked); return; }
  const button=event.target.closest('[data-favorite]');
  if (!button || !currentRun) return;
  const candidate=results.find(r=>r.id === Number(button.dataset.favorite));
  const runId=currentRun.id;
  button.disabled=true;
  try {
    const saved=await api(`/api/runs/${runId}/candidates/${candidate.id}/favorite`,{favorite:!candidate.favorite});
    if (currentRun?.id === runId) { const current=results.find(r=>r.id === candidate.id); current.favorite=saved.favorite; render(); }
    await loadHistory();
  } catch(error) { $('#message').textContent=error.message; button.disabled=false; }
});
function setAppendMode(enabled) {
  appendMode=enabled;
  $('#source').readOnly=enabled;
  $('#run-name').readOnly=enabled;
  $('#new-mode').hidden=!enabled;
  $('#mode-info').textContent=enabled ? `「${currentRun.name}」に追加します。元情報・プロンプトは保存済みの内容に固定されています。モデルと追加件数を選んでください。` : '新しい比較を作成します。過去の結果は履歴に残ります。';
  $('#run').textContent=enabled ? 'この結果に追加生成してJevで評価' : '新しく生成してJevで評価';
  updateAllocation();
}
$('#append-mode').onclick=()=>{
  if(!currentRun || busy || submitting) return;
  $('#source').value=currentRun.source;
  $('#run-name').value=currentRun.name;
  $('#prompts').innerHTML=''; currentRun.prompts.forEach((p,i)=>addPrompt(p,currentRun.prompt_enabled[i]));
  $('#count').value=1;
  setAppendMode(true);
  $('#setup').open=true;
  $('#setup').scrollIntoView({behavior:'smooth',block:'start'});
};
$('#new-mode').onclick=()=>setAppendMode(false);
// Implicit form submission (including Enter in model search) must never call the API.
$('#form').onsubmit=event=>event.preventDefault();
$('#run').addEventListener('keydown',event=>{
  if(event.key === 'Enter') event.preventDefault();
});
$('#run').onclick=async ()=>{
  if(busy || submitting || deleting || savingCriteria || !$('#form').reportValidity()) return;
  if(!appendMode && criteriaDirty) { $('#message').textContent='編集した評価基準を保存するか、保存済みの基準に戻してから生成してください。'; $('#criteria-panel').open=true; return; }
  const source=$('#source').value.trim(), values=prompts(), count=Number($('#count').value), model=$('#generation-model').value;
  const enabled=promptEntries().map(p=>p.enabled), effort=$('#effort').value;
  if(!enabled.some(Boolean)) { $('#message').textContent='プロンプトを1件以上有効にしてください。'; return; }
  if(!source || values.some((p,i)=>enabled[i] && !p)) { $('#message').textContent='元情報と各プロンプトを入力してください。'; return; }
  if(!model) { $('#message').textContent='生成モデルを選択してください。'; return; }
  if(!effort) { $('#message').textContent='Reasoning Effortを選択してください。'; return; }
  if(!appendMode) savePrompts();
  const targetId=appendMode ? currentRun?.id : null;
  const previousSelection=[...selected];
  submitting=true; busy=true; $('#inputs').disabled=true; $('#append-mode').disabled=true;
  try {
    const run=targetId
      ? await api(`/api/runs/${targetId}/append`,{count,model,effort})
      : await api('/api/runs',{source,prompts:values,prompt_enabled:enabled,count,model,effort,name:$('#run-name').value});
    await openRun(run.id);
    if(targetId && currentRun?.id === targetId) {
      selected=new Set([...previousSelection,run.candidate_ids[0]]);
      render();
    }
    await loadHistory();
  } catch(error) { $('#message').textContent=error.message; busy=currentRun?.status === '実行中'; }
  finally { submitting=false; $('#inputs').disabled=busy; render(); }
};
function updateDeleteButton() {
  const count=results.filter(r=>selected.has(r.id)).length;
  $('#delete-selected').hidden=!currentRun || !results.length;
  $('#delete-selected').disabled=!count || busy || submitting || deleting;
  $('#delete-selected').textContent=`選択した${count}件を削除`;
}
$('#delete-selected').onclick=async()=>{
  if(!currentRun || busy || submitting || deleting) return;
  const ids=results.filter(r=>selected.has(r.id)).map(r=>r.id);
  if(!ids.length || !confirm(`候補 ${ids.map(id=>'#'+id).join(', ')} の${ids.length}件を削除します。文章・評価・お気に入り指定も削除されます。よろしいですか？`)) return;
  const runId=currentRun.id;
  deleting=true; updateDeleteButton();
  try {
    await api(`/api/runs/${runId}/delete-candidates`,{candidate_ids:ids});
    const run=await api('/api/runs/'+runId);
    if(currentRun?.id === runId) {
      ids.forEach(id=>selected.delete(id));
      displayRun(run); updateAllocation();
      $('#message').textContent=`${ids.length}件を削除しました。`;
    }
    await loadHistory();
  } catch(error) { $('#message').textContent=error.message; }
  finally { deleting=false; updateDeleteButton(); }
};
function renderCriteria() {
  if(!config?.questions) return;
  $('#criteria-editor').innerHTML=Object.entries(config.questions).map(([key,q])=>{
    const entries=key === 'suspicious' ? Object.entries(q.criteria) : q.criteria.map((text,index)=>[String(index),text]);
    return `<details class="criterion"><summary>${escape(axes[key] || '重大な問題の判定')}</summary><label>評価の指示文<textarea required maxlength="6000" rows="4" data-axis="${key}" data-part="instructions">${escape(q.instructions)}</textarea></label>${entries.map(([level,text])=>`<label>${key === 'suspicious' ? (level === 'true' ? '問題あり（true）' : '問題なし（false）') : level+'点の基準'}<textarea required maxlength="6000" rows="3" data-axis="${key}" data-part="${level}">${escape(text)}</textarea></label>`).join('')}</details>`;
  }).join('');
  criteriaDirty=false; $('#criteria-status').textContent='保存済みの基準を表示しています。';
}
$('#criteria-form').onsubmit=event=>event.preventDefault();
$('#criteria-editor').addEventListener('input',()=>{criteriaDirty=true; $('#criteria-status').textContent='未保存の変更があります。';});
$('#reset-criteria').onclick=renderCriteria;
$('#save-criteria').onclick=async()=>{
  if(!config || savingCriteria) return;
  const fields=[...document.querySelectorAll('#criteria-editor textarea')];
  const invalid=fields.find(field=>!field.value.trim() || !field.checkValidity());
  if(invalid) { invalid.closest('details').open=true; invalid.focus(); $('#criteria-status').textContent='指示文と各基準を1〜6000文字で入力してください。'; return; }
  const questions=JSON.parse(JSON.stringify(config.questions));
  fields.forEach(field=>{
    const question=questions[field.dataset.axis], part=field.dataset.part;
    if(part === 'instructions') question.instructions=field.value;
    else question.criteria[part]=field.value;
  });
  savingCriteria=true; $('#criteria-fields').disabled=true;
  try {
    const saved=await api('/api/questions',{questions});
    config.questions=saved.questions; criteriaDirty=false;
    $('#criteria-status').textContent='保存しました。次の新規生成に適用します。';
  } catch(error) { $('#criteria-status').textContent=error.message; }
  finally { savingCriteria=false; $('#criteria-fields').disabled=false; }
};
async function initialize() {
  try {
    config=await api('/api/config');
    renderCriteria();
    $('#models').textContent=`評価 ${config.evaluation_model} · 生成モデルは選択可能`;
    if(!config.key_configured) $('#message').textContent='.envにAPI_KEYを設定して、コンテナを再作成してください。';
    await loadModels();
    await loadHistory();
    const id=location.hash.slice(1);
    if(id) await openRun(id,false,false);
  } catch(error) { $('#message').textContent=error.message; }
}
initialize();
