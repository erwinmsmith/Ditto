document.getElementById('save').addEventListener('click', async () => {
  try { document.getElementById('status').textContent = await window.notes.save({ title: document.getElementById('title').value, body: document.getElementById('body').value }); }
  catch { document.getElementById('status').textContent = 'Save failed'; }
});
