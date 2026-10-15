// @ts-nocheck — browser script with no type info for d3 or the webview API
/* global d3, acquireVsCodeApi */
(function () {
    const vscode = acquireVsCodeApi();

    // Directory colours, assigned in fixed sorted order of directory name. Beyond
    // the palette, everything is "other" rather than cycling hues.
    const DIR_COLORS = [
        'var(--vscode-charts-blue)',
        'var(--vscode-charts-orange)',
        'var(--vscode-charts-green)',
        'var(--vscode-charts-purple)',
        'var(--vscode-charts-red)',
        'var(--vscode-charts-yellow)',
    ];
    const OTHER_COLOR = 'var(--vscode-charts-lines)';
    const LABELS_ALWAYS = 30; // top-N nodes by weight keep a label when zoomed out
    const LABEL_ZOOM = 1.6;

    const saved = vscode.getState() || {};
    /** @type {any} */
    let data = null;
    let view = saved.view || 'force';
    let filter = saved.filter || '';
    let topFiles = saved.topFiles || 40;
    let minShared = saved.minShared || 1;
    /** @type {{names: string[], color: Map<string, string>}} */
    let groups = { names: [], color: new Map() };
    /** @type {null | (() => void)} */
    let onResize = null;

    const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
    const els = {
        canvas: $('canvas'),
        tooltip: $('tooltip'),
        status: $('status'),
        stats: $('stats'),
        legend: $('legend'),
        filter: /** @type {HTMLInputElement} */ ($('filter')),
        topFiles: /** @type {HTMLInputElement} */ ($('topFiles')),
        topFilesWrap: $('topFilesWrap'),
        minShared: /** @type {HTMLInputElement} */ ($('minShared')),
        minSharedWrap: $('minSharedWrap'),
        btnForce: $('btn-force'),
        btnChord: $('btn-chord'),
        btnScan: /** @type {HTMLButtonElement} */ ($('btn-scan')),
        btnBrowse: $('btn-browse'),
        directory: /** @type {HTMLInputElement} */ ($('directory')),
        files: /** @type {HTMLInputElement} */ ($('files')),
        identifier: /** @type {HTMLInputElement} */ ($('identifier')),
        separator: /** @type {HTMLInputElement} */ ($('separator')),
    };

    // ---------------------------------------------------------------- helpers

    function saveState() {
        vscode.setState({ view, filter, topFiles, minShared });
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function basename(p) {
        const i = p.lastIndexOf('/');
        return i < 0 ? p : p.slice(i + 1);
    }

    function groupOf(file) {
        const i = file.indexOf('/');
        return i < 0 ? '(root)' : file.slice(0, i);
    }

    function symbolMatches(name) {
        return !filter || name.toLowerCase().includes(filter.toLowerCase());
    }

    function plural(n, word) {
        return `${n} ${word}${n === 1 ? '' : 's'}`;
    }

    function size() {
        const r = els.canvas.getBoundingClientRect();
        return { width: Math.max(100, r.width), height: Math.max(100, r.height) };
    }

    function clearCanvas() {
        onResize = null;
        hideTooltip();
        els.canvas.innerHTML = '';
    }

    function showMessage(text, isError) {
        clearCanvas();
        const div = document.createElement('div');
        div.className = 'message' + (isError ? ' error' : '');
        div.textContent = text;
        els.canvas.appendChild(div);
    }

    function showTooltip(event, html) {
        els.tooltip.innerHTML = html;
        els.tooltip.style.display = 'block';
        moveTooltip(event);
    }

    function moveTooltip(event) {
        const pad = 12;
        const r = els.tooltip.getBoundingClientRect();
        let x = event.clientX + pad;
        let y = event.clientY + pad;
        if (x + r.width > window.innerWidth - 8) {
            x = event.clientX - r.width - pad;
        }
        if (y + r.height > window.innerHeight - 8) {
            y = event.clientY - r.height - pad;
        }
        els.tooltip.style.left = `${Math.max(0, x)}px`;
        els.tooltip.style.top = `${Math.max(0, y)}px`;
    }

    function hideTooltip() {
        els.tooltip.style.display = 'none';
    }

    function open(file, line) {
        vscode.postMessage({ type: 'open', file, line });
    }

    // Groups are computed from every file in the data set, so a directory keeps
    // its colour no matter how the filter changes.
    function computeGroups() {
        const names = [...new Set(data.symbols.flatMap((s) => s.refs.map((r) => groupOf(r.file))))].sort();
        const color = new Map();
        names.forEach((g, i) => color.set(g, i < DIR_COLORS.length ? DIR_COLORS[i] : OTHER_COLOR));
        groups = { names, color };
    }

    function renderLegend(extraItems) {
        const items = [];
        const shown = groups.names.slice(0, DIR_COLORS.length);
        for (const g of shown) {
            items.push(`<span class="legend-item"><span class="swatch" style="background:${groups.color.get(g)}"></span>${esc(g)}/</span>`);
        }
        if (groups.names.length > DIR_COLORS.length) {
            items.push(`<span class="legend-item"><span class="swatch" style="background:${OTHER_COLOR}"></span>other (${groups.names.length - DIR_COLORS.length} dirs)</span>`);
        }
        els.legend.innerHTML = items.concat(extraItems || []).join('');
    }

    // ---------------------------------------------------------------- force graph

    function forceModel() {
        const nodes = new Map();
        const links = [];
        for (const s of data.symbols) {
            if (!s.refs.length || !symbolMatches(s.name)) {
                continue;
            }
            const total = s.refs.reduce((a, r) => a + r.count, 0);
            const sid = 's:' + s.name;
            nodes.set(sid, { id: sid, type: 'symbol', label: s.name, weight: total, files: s.refs.length, decl: s.decl });
            for (const r of s.refs) {
                const fid = 'f:' + r.file;
                let f = nodes.get(fid);
                if (!f) {
                    f = { id: fid, type: 'file', label: basename(r.file), file: r.file, group: groupOf(r.file), weight: 0, symbols: 0 };
                    nodes.set(fid, f);
                }
                f.weight += r.count;
                f.symbols += 1;
                links.push({
                    source: sid,
                    target: fid,
                    count: r.count,
                    symbol: s.name,
                    file: r.file,
                    decl: !!(s.decl && s.decl.file === r.file),
                });
            }
        }
        const list = [...nodes.values()];
        // mark the heaviest nodes so they keep a label when zoomed out
        [...list].sort((a, b) => b.weight - a.weight).slice(0, LABELS_ALWAYS).forEach((n) => (n.labelAlways = true));
        return { nodes: list, links };
    }

    function renderForce() {
        clearCanvas();
        const m = forceModel();
        if (!m.nodes.length) {
            showMessage(filter ? `No symbols match "${filter}".` : 'No references found.');
            els.status.textContent = '';
            return;
        }

        let { width, height } = size();
        const svg = d3.select(els.canvas).append('svg').attr('viewBox', [0, 0, width, height]);
        const g = svg.append('g');

        const maxWeight = d3.max(m.nodes, (d) => d.weight) || 1;
        const maxCount = d3.max(m.links, (d) => d.count) || 1;
        const radius = d3.scaleSqrt().domain([1, maxWeight]).range([4, 16]);
        const strokeW = d3.scaleLinear().domain([1, maxCount]).range([1, 4]);
        const r = (d) => radius(Math.max(1, d.weight));

        const adjacency = new Map();
        for (const l of m.links) {
            if (!adjacency.has(l.source)) adjacency.set(l.source, new Set());
            if (!adjacency.has(l.target)) adjacency.set(l.target, new Set());
            adjacency.get(l.source).add(l.target);
            adjacency.get(l.target).add(l.source);
        }

        const sim = d3
            .forceSimulation(m.nodes)
            .force('link', d3.forceLink(m.links).id((d) => d.id).distance((d) => 30 + 50 / Math.sqrt(d.count)).strength(0.4))
            .force('charge', d3.forceManyBody().strength(-140))
            .force('collide', d3.forceCollide((d) => r(d) + 5))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('x', d3.forceX(width / 2).strength(0.03))
            .force('y', d3.forceY(height / 2).strength(0.03));

        const link = g
            .append('g')
            .selectAll('line')
            .data(m.links)
            .join('line')
            .attr('class', (d) => 'link' + (d.decl ? ' decl' : ''))
            .attr('stroke-width', (d) => strokeW(d.count));

        const node = g
            .append('g')
            .selectAll('g')
            .data(m.nodes)
            .join('g')
            .attr('class', (d) => `node ${d.type}`)
            .call(drag(sim));

        node.filter((d) => d.type === 'symbol').append('circle').attr('class', 'shape').attr('r', r);
        node.filter((d) => d.type === 'file')
            .append('rect')
            .attr('class', 'shape')
            .attr('x', (d) => -r(d))
            .attr('y', (d) => -r(d))
            .attr('width', (d) => 2 * r(d))
            .attr('height', (d) => 2 * r(d))
            .attr('rx', 2)
            .style('fill', (d) => groups.color.get(d.group));

        const label = node
            .append('text')
            .attr('dx', (d) => r(d) + 3)
            .attr('dy', '0.35em')
            .text((d) => d.label);

        let zoomK = 1;
        let hot = null; // id of the hovered node
        function updateLabels() {
            label.style('display', (d) => (d.labelAlways || zoomK >= LABEL_ZOOM || (hot && (hot === d.id || adjacency.get(hot)?.has(d.id)))) ? null : 'none');
        }
        updateLabels();

        node.on('mouseenter', (event, d) => {
            hot = d.id;
            const near = adjacency.get(d.id) || new Set();
            node.classed('dim', (n) => n.id !== d.id && !near.has(n.id));
            link.classed('dim', (l) => l.source.id !== d.id && l.target.id !== d.id);
            updateLabels();
            showTooltip(event, nodeTooltip(d));
        })
            .on('mousemove', moveTooltip)
            .on('mouseleave', () => {
                hot = null;
                node.classed('dim', false);
                link.classed('dim', false);
                updateLabels();
                hideTooltip();
            })
            .on('click', (event, d) => {
                if (event.defaultPrevented) return; // was a drag
                if (d.type === 'file') {
                    open(d.file);
                } else if (d.decl) {
                    open(d.decl.file, d.decl.line);
                }
            });

        link.on('mouseenter', (event, d) => {
            showTooltip(event, `<div class="t-title">${esc(d.symbol)} → ${esc(d.file)}</div><div>${plural(d.count, 'reference')}${d.decl ? ' <span class="t-muted">(declaring file)</span>' : ''}</div>`);
        })
            .on('mousemove', moveTooltip)
            .on('mouseleave', hideTooltip);

        sim.on('tick', () => {
            link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
            node.attr('transform', (d) => `translate(${d.x},${d.y})`);
        });

        svg.call(
            d3.zoom().scaleExtent([0.1, 8]).on('zoom', (event) => {
                g.attr('transform', event.transform);
                const crossed = (event.transform.k >= LABEL_ZOOM) !== (zoomK >= LABEL_ZOOM);
                zoomK = event.transform.k;
                if (crossed) {
                    updateLabels();
                }
            }),
        ).on('dblclick.zoom', null);

        onResize = () => {
            ({ width, height } = size());
            svg.attr('viewBox', [0, 0, width, height]);
            sim.force('center', d3.forceCenter(width / 2, height / 2))
                .force('x', d3.forceX(width / 2).strength(0.03))
                .force('y', d3.forceY(height / 2).strength(0.03))
                .alpha(0.2)
                .restart();
        };

        const nSym = m.nodes.filter((n) => n.type === 'symbol').length;
        const nFiles = m.nodes.length - nSym;
        const nRefs = d3.sum(m.links, (d) => d.count);
        els.status.textContent = `${plural(nSym, 'symbol')} · ${plural(nFiles, 'file')} · ${plural(nRefs, 'reference')} · scroll to zoom, drag to move, click a node to open it`;
        renderLegend([
            '<span class="legend-item"><span class="swatch circle"></span>symbol</span>',
            '<span class="legend-item"><span class="swatch" style="background:var(--rg-line)"></span>file (colour = directory)</span>',
            '<span class="legend-item"><span class="swatch dashed"></span>declaring file</span>',
        ]);
    }

    function nodeTooltip(d) {
        if (d.type === 'file') {
            return `<div class="t-title"><code>${esc(d.file)}</code></div><div>${plural(d.symbols, 'symbol')}, ${plural(d.weight, 'reference')}</div><div class="t-muted">click to open</div>`;
        }
        const decl = d.decl ? `<div class="t-muted">declared in <code>${esc(d.decl.file)}:${d.decl.line}</code></div>` : '';
        return `<div class="t-title">${esc(d.label)}</div><div>${plural(d.weight, 'reference')} in ${plural(d.files, 'file')}</div>${decl}${d.decl ? '<div class="t-muted">click to open declaration</div>' : ''}`;
    }

    function drag(sim) {
        return d3
            .drag()
            .on('start', (event, d) => {
                if (!event.active) sim.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
            })
            .on('drag', (event, d) => {
                d.fx = event.x;
                d.fy = event.y;
            })
            .on('end', (event, d) => {
                if (!event.active) sim.alphaTarget(0);
                d.fx = null;
                d.fy = null;
            });
    }

    // ---------------------------------------------------------------- chord

    // Two files are coupled when they reference the same symbol; the weight is
    // the number of symbols they share.
    function chordModel() {
        const files = [...new Set(data.symbols.filter((s) => symbolMatches(s.name)).flatMap((s) => s.refs.map((r) => r.file)))];
        const idx = new Map(files.map((f, i) => [f, i]));
        const shared = new Map(); // "i|j" (i<j) -> symbol names

        for (const s of data.symbols) {
            if (!symbolMatches(s.name)) continue;
            const fs = s.refs.map((r) => idx.get(r.file));
            for (let a = 0; a < fs.length; a++) {
                for (let b = a + 1; b < fs.length; b++) {
                    const key = `${Math.min(fs[a], fs[b])}|${Math.max(fs[a], fs[b])}`;
                    if (!shared.has(key)) shared.set(key, []);
                    shared.get(key).push(s.name);
                }
            }
        }

        // Every pair below the threshold is dropped before ranking files, so the
        // ribbons that remain share the whole circle.
        let weakPairs = 0;
        for (const [key, syms] of shared) {
            if (syms.length < minShared) {
                shared.delete(key);
                weakPairs += 1;
            }
        }

        const degree = new Array(files.length).fill(0);
        for (const [key, syms] of shared) {
            const [i, j] = key.split('|').map(Number);
            degree[i] += syms.length;
            degree[j] += syms.length;
        }

        const coupled = files.map((_, i) => i).filter((i) => degree[i] > 0);
        const keep = [...coupled].sort((a, b) => degree[b] - degree[a]).slice(0, topFiles);
        // order arcs by directory so the ring shows directory blocks
        keep.sort((a, b) => groupOf(files[a]).localeCompare(groupOf(files[b])) || files[a].localeCompare(files[b]));

        const pos = new Map(keep.map((i, n) => [i, n]));
        const n = keep.length;
        const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
        const pairSymbols = new Map();
        for (const [key, syms] of shared) {
            const [i, j] = key.split('|').map(Number);
            if (!pos.has(i) || !pos.has(j)) continue;
            const a = pos.get(i);
            const b = pos.get(j);
            matrix[a][b] = syms.length;
            matrix[b][a] = syms.length;
            pairSymbols.set(`${Math.min(a, b)}|${Math.max(a, b)}`, syms.sort());
        }

        return { files: keep.map((i) => files[i]), matrix, pairSymbols, coupledFiles: coupled.length, weakPairs };
    }

    function renderChord() {
        clearCanvas();
        const m = chordModel();
        if (m.files.length < 2) {
            let why = 'Not enough coupled files to draw a chord diagram.';
            if (filter) why = `No file pairs share a symbol matching "${filter}".`;
            else if (minShared > 1 && m.weakPairs > 0) why = `No file pairs share ${minShared} or more symbols. Lower "Min shared".`;
            showMessage(why);
            els.status.textContent = '';
            return;
        }

        const { width, height } = size();
        const svg = d3.select(els.canvas).append('svg').attr('viewBox', [0, 0, width, height]);
        const g = svg.append('g').attr('transform', `translate(${width / 2},${height / 2})`);

        // leave just enough room outside the ring for the longest label
        const longest = d3.max(m.files, (f) => basename(f).length) || 10;
        const labelMargin = Math.min(110, 14 + longest * 6);
        const outer = Math.max(40, Math.min(width, height) / 2 - labelMargin);
        const inner = outer - 12;
        const chords = d3.chord().padAngle(3 / inner).sortSubgroups(d3.descending)(m.matrix);
        const arc = d3.arc().innerRadius(inner).outerRadius(outer);
        const ribbon = d3.ribbon().radius(inner - 1).padAngle(1 / inner);
        const colorOf = (i) => groups.color.get(groupOf(m.files[i]));
        const pairKey = (d) => `${Math.min(d.source.index, d.target.index)}|${Math.max(d.source.index, d.target.index)}`;

        const ribbons = g
            .append('g')
            .selectAll('path')
            .data(chords)
            .join('path')
            .attr('class', 'ribbon')
            .attr('d', ribbon)
            .style('fill', (d) => colorOf(d.source.index));

        const group = g.append('g').selectAll('g').data(chords.groups).join('g');

        const arcs = group.append('path').attr('class', 'arc').attr('d', arc).style('fill', (d) => colorOf(d.index));

        group
            .append('text')
            .attr('class', 'arc-label')
            .each((d) => {
                d.angle = (d.startAngle + d.endAngle) / 2;
            })
            .attr('dy', '0.35em')
            .attr('transform', (d) => `rotate(${(d.angle * 180) / Math.PI - 90}) translate(${outer + 5}) ${d.angle > Math.PI ? 'rotate(180)' : ''}`)
            .attr('text-anchor', (d) => (d.angle > Math.PI ? 'end' : null))
            .text((d) => basename(m.files[d.index]));

        function reset() {
            ribbons.classed('dim', false).classed('hot', false);
            arcs.classed('dim', false);
            hideTooltip();
        }

        arcs.on('mouseenter', (event, d) => {
            const touching = new Set();
            ribbons.classed('dim', (c) => {
                const hit = c.source.index === d.index || c.target.index === d.index;
                if (hit) {
                    touching.add(c.source.index);
                    touching.add(c.target.index);
                }
                return !hit;
            }).classed('hot', (c) => c.source.index === d.index || c.target.index === d.index);
            arcs.classed('dim', (a) => !touching.has(a.index) && a.index !== d.index);
            const file = m.files[d.index];
            showTooltip(event, `<div class="t-title"><code>${esc(file)}</code></div><div>coupled with ${plural(touching.size - 1, 'file')} through ${plural(d.value, 'shared symbol link')}</div><div class="t-muted">click to open</div>`);
        })
            .on('mousemove', moveTooltip)
            .on('mouseleave', reset)
            .on('click', (event, d) => open(m.files[d.index]));

        ribbons.on('mouseenter', (event, d) => {
            ribbons.classed('dim', (c) => c !== d).classed('hot', (c) => c === d);
            arcs.classed('dim', (a) => a.index !== d.source.index && a.index !== d.target.index);
            const syms = m.pairSymbols.get(pairKey(d)) || [];
            const shown = syms.slice(0, 12).map(esc).join(', ') + (syms.length > 12 ? `, … +${syms.length - 12} more` : '');
            showTooltip(event, `<div class="t-title"><code>${esc(m.files[d.source.index])}</code> ↔ <code>${esc(m.files[d.target.index])}</code></div><div>${plural(syms.length, 'shared symbol')}</div><div class="t-muted">${shown}</div>`);
        })
            .on('mousemove', moveTooltip)
            .on('mouseleave', reset);

        svg.call(
            d3.zoom().scaleExtent([0.3, 6]).on('zoom', (event) => {
                g.attr('transform', event.transform.translate(width / 2, height / 2).toString());
            }),
        ).on('dblclick.zoom', null);

        onResize = renderChord;

        const hidden = m.coupledFiles - m.files.length;
        els.status.textContent =
            `${m.files.length} of ${plural(m.coupledFiles, 'coupled file')} · ${plural(chords.length, 'ribbon')} · ribbon width = number of shared symbols` +
            (hidden > 0 ? ` · ${hidden} least-coupled files hidden (raise "Top files")` : '') +
            (m.weakPairs > 0 ? ` · ${plural(m.weakPairs, 'pair')} below ${minShared} shared hidden` : '') +
            ' · click an arc to open the file';
        renderLegend();
    }

    // ---------------------------------------------------------------- orchestration

    function render() {
        els.btnForce.classList.toggle('active', view === 'force');
        els.btnChord.classList.toggle('active', view === 'chord');
        els.topFilesWrap.style.display = view === 'chord' ? '' : 'none';
        els.minSharedWrap.style.display = view === 'chord' ? '' : 'none';
        if (!data) {
            return;
        }
        if (view === 'force') {
            renderForce();
        } else {
            renderChord();
        }
    }

    function setView(v) {
        if (v !== 'force' && v !== 'chord') return;
        view = v;
        saveState();
        render();
    }

    function updateStats() {
        if (!data) {
            els.stats.textContent = '';
            return;
        }
        const files = new Set(data.symbols.flatMap((s) => s.refs.map((r) => r.file)));
        const refs = d3.sum(data.symbols, (s) => d3.sum(s.refs, (r) => r.count));
        els.stats.textContent = `${esc(data.identifier.trim())}: ${plural(data.symbols.length, 'symbol')} · ${plural(files.size, 'file')} · ${plural(refs, 'reference')}`;
        els.stats.title = data.root;
    }

    els.btnForce.addEventListener('click', () => setView('force'));
    els.btnChord.addEventListener('click', () => setView('chord'));

    // Same syntax the scanner compiles (ECMAScript), so a pattern that fails
    // here would fail there too; catch it before spending a scan on it.
    const filesTitle = els.files.title;
    function filesPatternValid() {
        try {
            new RegExp(els.files.value, 'i');
            els.files.classList.remove('invalid');
            els.files.title = filesTitle;
            return true;
        } catch (e) {
            els.files.classList.add('invalid');
            els.files.title = `Invalid regex: ${e.message}`;
            return false;
        }
    }
    els.files.addEventListener('input', filesPatternValid);

    function scan() {
        const identifier = els.identifier.value;
        if (!identifier) {
            els.identifier.focus();
            return;
        }
        if (!filesPatternValid()) {
            els.files.focus();
            return;
        }
        els.btnScan.disabled = true;
        vscode.postMessage({
            type: 'scan',
            directory: els.directory.value.trim() || '.',
            filesPattern: els.files.value.trim(),
            identifier,
            separator: els.separator.value,
        });
    }
    els.btnScan.addEventListener('click', scan);
    els.btnBrowse.addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
    for (const input of [els.directory, els.files, els.identifier, els.separator]) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                scan();
            }
        });
    }

    let filterTimer = 0;
    els.filter.value = filter;
    els.filter.addEventListener('input', () => {
        window.clearTimeout(filterTimer);
        filterTimer = window.setTimeout(() => {
            filter = els.filter.value.trim();
            saveState();
            render();
        }, 150);
    });

    els.topFiles.value = String(topFiles);
    els.topFiles.addEventListener('change', () => {
        const n = parseInt(els.topFiles.value, 10);
        if (Number.isFinite(n) && n >= 2) {
            topFiles = n;
            saveState();
            render();
        }
    });

    els.minShared.value = String(minShared);
    els.minShared.addEventListener('change', () => {
        const n = parseInt(els.minShared.value, 10);
        if (Number.isFinite(n) && n >= 1) {
            minShared = n;
            saveState();
            render();
        }
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => onResize && onResize(), 150);
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'data':
                data = msg.data;
                els.btnScan.disabled = false;
                computeGroups();
                updateStats();
                render();
                break;
            case 'config':
                // don't clobber a value the user is in the middle of typing
                if (document.activeElement !== els.directory) els.directory.value = msg.directory;
                if (document.activeElement !== els.files) {
                    els.files.value = msg.filesPattern;
                    filesPatternValid();
                }
                if (document.activeElement !== els.identifier) els.identifier.value = msg.identifier;
                if (document.activeElement !== els.separator) els.separator.value = msg.separator;
                break;
            case 'directoryPicked':
                els.directory.value = msg.directory;
                scan();
                break;
            case 'setView':
                setView(msg.view);
                break;
            case 'loading':
                els.btnScan.disabled = true;
                showMessage('Running the scanner…');
                els.status.textContent = '';
                break;
            case 'error':
                els.btnScan.disabled = false;
                showMessage(msg.message, true);
                break;
        }
    });

    render();
    vscode.postMessage({ type: 'ready' });
})();
