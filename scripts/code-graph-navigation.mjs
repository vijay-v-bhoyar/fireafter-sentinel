// The generated viewer owns these bindings; this runs after its initialization.
export const codeGraphNavigation = String.raw`
(() => {
  if (!RAW_NODES.some(n => n.id === 'project:fireafter')) return;
  const notice = document.getElementById('snapshot-notice');
  const controls = document.createElement('div');
  controls.id = 'graph-navigation';
  controls.innerHTML = '<button type="button" id="graph-overview">Overview</button><button type="button" id="graph-all">All symbols</button><span id="graph-view-status" role="status"></span>';
  notice.appendChild(controls);
  const status = document.getElementById('graph-view-status');
  const legend = document.getElementById('legend-wrap');
  let view = 'overview';
  function show(ids, label, overview = false) {
    const selected = new Set(ids);
    const shown = nodesDS.get().filter(n => selected.has(n.id)).map(n => ({ ...n, hidden: false }));
    if (overview) {
      const folders = shown.filter(n => n.id !== 'project:fireafter');
      shown.forEach(n => {
        const index = folders.findIndex(f => f.id === n.id);
        const angle = 2 * Math.PI * index / folders.length;
        n.x = index < 0 ? 0 : Math.cos(angle) * 330;
        n.y = index < 0 ? 0 : Math.sin(angle) * 230;
        n.fixed = true;
        n.size = index < 0 ? 30 : 20;
        n.font = { color: '#f8fafc', size: 18, strokeWidth: 4, strokeColor: '#101018' };
      });
    }
    const edges = edgesDS.get().filter(e => selected.has(e.from) && selected.has(e.to));
    network.setData({ nodes: new vis.DataSet(shown), edges: new vis.DataSet(edges) });
    network.setOptions({ physics: { enabled: !overview } });
    if (!overview) {
      network.once('stabilizationIterationsDone', () => network.setOptions({ physics: { enabled: false } }));
      network.stabilize(120);
    }
    network.fit({ animation: false });
    legend.hidden = true;
    status.textContent = label + ' | ' + shown.length + ' shown / ' + RAW_NODES.length + ' indexed';
  }
  function overview() {
    view = 'overview';
    show(RAW_NODES.filter(n => n.id === 'project:fireafter' || n.id.startsWith('directory:')).map(n => n.id), 'Folder overview', true);
    document.getElementById('info-content').textContent = 'Choose a folder to inspect its files, or search for a symbol. Folder links show ownership, not runtime calls.';
  }
  function area(id) {
    view = 'area';
    const files = RAW_EDGES.filter(e => e.from === id && e.to.startsWith('file:')).map(e => e.to);
    show([id, ...files], id.slice('directory:'.length));
    showInfo(id);
  }
  const originalFocus = focusNode;
  focusNode = function(id) {
    if (id === 'project:fireafter') return overview();
    if (id.startsWith('directory:')) return area(id);
    view = 'detail';
    const neighbors = RAW_EDGES.filter(e => e.from === id || e.to === id).flatMap(e => [e.from, e.to]);
    show([id, ...neighbors], 'Selected node and direct neighbors');
    originalFocus(id);
  };
  network.on('click', params => {
    const id = params.nodes[0];
    if (id && (view === 'overview' || view === 'area')) focusNode(id);
  });
  document.getElementById('graph-overview').addEventListener('click', overview);
  document.getElementById('graph-all').addEventListener('click', () => {
    view = 'all';
    network.setData({ nodes: nodesDS, edges: edgesDS });
    network.setOptions({ physics: { enabled: true } });
    network.once('stabilizationIterationsDone', () => network.setOptions({ physics: { enabled: false } }));
    network.stabilize(200);
    network.fit({ animation: false });
    legend.hidden = false;
    status.textContent = 'Complete graph | ' + RAW_NODES.length + ' nodes';
  });
  overview();
})();
`;
