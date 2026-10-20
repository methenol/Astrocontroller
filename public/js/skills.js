/** The agent's skills: list them, read one, edit and save it. */
import { $, $$, esc, toast } from './dom.js';
import { api, seg } from './api.js';
import { on } from './bus.js';

const DESCRIPTION_PREVIEW = 90;
let current = null;
let dirty = false;

async function loadSkills() {
  try {
    const skills = await api('skills');
    const list = Array.isArray(skills) ? skills : [];
    $('#skills').innerHTML = list.map((s) => `<li data-skill="${esc(s.name)}" class="${s.name === current ? 'active' : ''}">${esc(s.name)}<small>${esc(String(s.description ?? '').slice(0, DESCRIPTION_PREVIEW))}</small></li>`).join('') || '<li class="muted">no skills yet</li>';
    $('.skill-editor').classList.toggle('on', !!current);
  } catch (e) {
    toast(e.message, true);
  }
}

$('#skills').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-skill]');
  if (!li || li.dataset.skill === current) return;
  if (dirty && !confirm(`Discard your changes to ${current}?`)) return;
  const name = li.dataset.skill;
  try {
    const s = await api(`skills/${seg(name)}`);
    current = name;
    dirty = false;
    $('#skill-name').textContent = name;
    $('#skill-content').value = s.content ?? '';
    $('#btn-skill-save').disabled = false;
    for (const x of $$('#skills li')) x.classList.toggle('active', x === li);
    $('.skill-editor').classList.add('on');
  } catch (err) {
    toast(err.message, true);
  }
});
$('#skill-content').addEventListener('input', () => (dirty = true));
$('#btn-skill-save').onclick = async () => {
  if (!current) return;
  const b = $('#btn-skill-save');
  b.disabled = true;
  const content = $('#skill-content').value;
  try {
    await api(`skills/${seg(current)}`, { content }, 'PUT');
    // an edit typed while it saved is still unsaved
    dirty = $('#skill-content').value !== content;
    toast('skill saved');
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false;
  }
};

on('tab', (name) => {
  if (name === 'skills') loadSkills();
});
