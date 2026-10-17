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
    let splitFile = saved.splitFile || null;
    let threshold = saved.threshold ?? 0.5;
    let mergeDeps = saved.mergeDeps ?? false;
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
        btnSplit: $('btn-split'),
        splitFile: /** @type {HTMLSelectElement} */ ($('splitFile')),
        splitFileWrap: $('splitFileWrap'),
        threshold: /** @type {HTMLInputElement} */ ($('threshold')),
        thresholdValue: $('thresholdValue'),
        thresholdWrap: $('thresholdWrap'),
        mergeDeps: /** @type {HTMLInputElement} */ ($('mergeDeps')),
        mergeDepsWrap: $('mergeDepsWrap'),
        btnCopyPlan: $('btn-copyPlan'),
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
        vscode.setState({ view, filter, topFiles, minShared, splitFile, threshold, mergeDeps });
    }

    function flashStatus(text) {
        const prev = els.status.textContent;
        els.status.textContent = text;
        window.setTimeout(() => {
            if (els.status.textContent === text) els.status.textContent = prev;
        }, 2000);
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

    function renderLegend(extraItems, includeDirs = true) {
        const items = [];
        if (includeDirs) {
            const shown = groups.names.slice(0, DIR_COLORS.length);
            for (const g of shown) {
                items.push(`<span class="legend-item"><span class="swatch" style="background:${groups.color.get(g)}"></span>${esc(g)}/</span>`);
            }
            if (groups.names.length > DIR_COLORS.length) {
                items.push(`<span class="legend-item"><span class="swatch" style="background:${OTHER_COLOR}"></span>other (${groups.names.length - DIR_COLORS.length} dirs)</span>`);
            }
        }
        els.legend.innerHTML = items.concat(extraItems || []).join('');
    }

    // ---------------------------------------------------------------- force graph

    function forceModel() {
        const nodes = new Map();
        const links = [];
        const fileNode = (file) => {
            const fid = 'f:' + file;
            let f = nodes.get(fid);
            if (!f) {
                f = { id: fid, type: 'file', label: basename(file), file, group: groupOf(file), weight: 0, symbols: 0 };
                nodes.set(fid, f);
            }
            return f;
        };
        for (const s of data.symbols) {
            if ((!s.refs.length && !s.decl) || !symbolMatches(s.name)) {
                continue;
            }
            const total = s.refs.reduce((a, r) => a + r.count, 0);
            const sid = 's:' + s.name;
            nodes.set(sid, { id: sid, type: 'symbol', label: s.name, weight: total, files: s.refs.length, decl: s.decl });
            for (const r of s.refs) {
                const f = fileNode(r.file);
                f.weight += r.count;
                f.symbols += 1;
                links.push({
                    source: sid,
                    target: f.id,
                    count: r.count,
                    symbol: s.name,
                    file: r.file,
                    decl: !!(s.decl && s.decl.file === r.file),
                });
            }
            // the declaration itself is not a reference, but the symbol still belongs next to its file
            if (s.decl && !s.refs.some((r) => r.file === s.decl.file)) {
                links.push({ source: sid, target: fileNode(s.decl.file).id, count: 0, symbol: s.name, file: s.decl.file, decl: true });
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
        const strokeW = d3.scaleLinear().domain([1, maxCount]).range([1, 4]).clamp(true);
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
            .force('link', d3.forceLink(m.links).id((d) => d.id).distance((d) => 30 + 50 / Math.sqrt(Math.max(1, d.count))).strength(0.4))
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
            const what = d.count === 0 ? 'declared here, not referenced elsewhere in this file' : `${plural(d.count, 'reference')}${d.decl ? ' <span class="t-muted">(declaring file)</span>' : ''}`;
            showTooltip(event, `<div class="t-title">${esc(d.symbol)} → ${esc(d.file)}</div><div>${what}</div>`);
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

    // ---------------------------------------------------------------- split header

    // Which files declare symbols, most declarations first.
    function declaringFiles() {
        const counts = new Map();
        for (const s of data.symbols) {
            if (s.decl) counts.set(s.decl.file, (counts.get(s.decl.file) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }

    function populateSplitFiles() {
        const files = declaringFiles();
        els.splitFile.innerHTML = files.map(([f, n]) => `<option value="${esc(f)}">${esc(f)} (${n})</option>`).join('');
        if (!files.some(([f]) => f === splitFile)) {
            splitFile = files.length ? files[0][0] : null;
        }
        if (splitFile) els.splitFile.value = splitFile;
    }

    // Average-linkage agglomerative clustering over a similarity matrix: keep merging
    // the two clusters with the highest mean pairwise similarity while it stays at or
    // above the threshold. Items with zero similarity to everything stay alone.
    function agglomerate(n, S, minSim) {
        let clusters = Array.from({ length: n }, (_, i) => [i]);
        const avg = (A, B) => {
            let t = 0;
            for (const a of A) for (const b of B) t += S[a][b];
            return t / (A.length * B.length);
        };
        while (clusters.length > 1) {
            let best = 0;
            let bi = -1;
            let bj = -1;
            for (let i = 0; i < clusters.length; i++) {
                for (let j = i + 1; j < clusters.length; j++) {
                    const v = avg(clusters[i], clusters[j]);
                    if (v > best) {
                        best = v;
                        bi = i;
                        bj = j;
                    }
                }
            }
            if (bi < 0 || best < minSim) break;
            clusters[bi] = clusters[bi].concat(clusters[bj]);
            clusters.splice(bj, 1);
        }
        return clusters;
    }

    function splitModel() {
        const file = splitFile;
        const declared = data.symbols.filter((s) => s.decl && s.decl.file === file && symbolMatches(s.name));
        const byName = new Map(declared.map((s) => [s.name, s]));

        // direct consumers: files other than the header itself that reference the symbol
        const direct = new Map(declared.map((s) => [s.name, new Set(s.refs.filter((r) => r.file !== file).map((r) => r.file))]));

        // dependencies inside the header: A uses B
        const deps = [];
        const usedBy = new Map(declared.map((s) => [s.name, []]));
        for (const s of declared) {
            for (const u of s.uses || []) {
                if (u !== s.name && byName.has(u)) {
                    deps.push({ source: s.name, target: u });
                    usedBy.get(u).push(s.name);
                }
            }
        }

        // Effective consumers: a file that needs A needs everything A uses, so B
        // inherits A's consumers. Iterate to a fixpoint; dependency cycles are possible.
        const consumers = new Map(declared.map((s) => [s.name, new Set(direct.get(s.name))]));
        let changed = true;
        while (changed) {
            changed = false;
            for (const { source, target } of deps) {
                const to = consumers.get(target);
                for (const f of consumers.get(source)) {
                    if (!to.has(f)) {
                        to.add(f);
                        changed = true;
                    }
                }
            }
        }

        const used = declared.filter((s) => consumers.get(s.name).size > 0).map((s) => s.name);
        const unused = declared.filter((s) => consumers.get(s.name).size === 0).map((s) => s.name).sort();

        // Jaccard index of the consumer sets
        const S = used.map((a) =>
            used.map((b) => {
                if (a === b) return 1;
                const A = consumers.get(a);
                const B = consumers.get(b);
                let inter = 0;
                for (const x of A) if (B.has(x)) inter++;
                const uni = A.size + B.size - inter;
                return uni ? inter / uni : 0;
            }),
        );

        let clusters = agglomerate(used.length, S, threshold).map((c) => c.map((i) => used[i]));

        if (mergeDeps) {
            // union-find over clusters joined by a dependency edge
            const owner = new Map();
            clusters.forEach((c, i) => c.forEach((name) => owner.set(name, i)));
            const parent = clusters.map((_, i) => i);
            const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (const { source, target } of deps) {
                if (owner.has(source) && owner.has(target)) parent[find(owner.get(source))] = find(owner.get(target));
            }
            const merged = new Map();
            clusters.forEach((c, i) => {
                const root = find(i);
                merged.set(root, (merged.get(root) || []).concat(c));
            });
            clusters = [...merged.values()];
        }

        const groups = clusters
            .map((names) => {
                const files = new Set();
                for (const name of names) for (const f of consumers.get(name)) files.add(f);
                return { names: names.sort(), files: [...files].sort() };
            })
            .sort((a, b) => b.names.length - a.names.length || b.files.length - a.files.length || a.names[0].localeCompare(b.names[0]));
        groups.forEach((g, i) => (g.id = i + 1));

        const groupOf = new Map();
        for (const g of groups) for (const name of g.names) groupOf.set(name, g.id);
        for (const g of groups) {
            g.dependsOn = new Set();
            for (const { source, target } of deps) {
                if (groupOf.get(source) === g.id && groupOf.has(target) && groupOf.get(target) !== g.id) g.dependsOn.add(groupOf.get(target));
            }
        }

        const links = [];
        for (let i = 0; i < used.length; i++) {
            for (let j = i + 1; j < used.length; j++) {
                if (S[i][j] >= threshold) links.push({ source: used[i], target: used[j], sim: S[i][j] });
            }
        }

        return { file, declared, byName, direct, consumers, usedBy, deps, groups, groupOf, unused, links };
    }

    function colorOfGroup(id) {
        return id && id <= DIR_COLORS.length ? DIR_COLORS[id - 1] : OTHER_COLOR;
    }

    function renderSplit() {
        clearCanvas();
        if (!splitFile) {
            showMessage('No scanned file declares a symbol.');
            els.status.textContent = '';
            return;
        }
        const m = splitModel();
        if (!m.declared.length) {
            showMessage(filter ? `No symbol declared in ${splitFile} matches "${filter}".` : `${splitFile} declares nothing.`);
            els.status.textContent = '';
            return;
        }

        const wrap = d3.select(els.canvas).append('div').attr('class', 'split');
        const graphEl = wrap.append('div').attr('class', 'split-graph');
        const aside = wrap.append('aside').attr('class', 'split-groups');

        const rect = graphEl.node().getBoundingClientRect();
        let width = Math.max(100, rect.width);
        let height = Math.max(100, rect.height);
        const svg = graphEl.append('svg').attr('viewBox', [0, 0, width, height]);
        svg.append('defs')
            .append('marker')
            .attr('id', 'arrow')
            .attr('viewBox', '0 -4 8 8')
            .attr('refX', 8)
            .attr('markerWidth', 6)
            .attr('markerHeight', 6)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-4L8,0L0,4')
            .attr('class', 'arrow-head');
        const g = svg.append('g');

        const nodes = m.declared.map((s) => ({
            id: s.name,
            label: s.name,
            group: m.groupOf.get(s.name) || 0,
            decl: s.decl,
            consumers: m.consumers.get(s.name),
            direct: m.direct.get(s.name),
            uses: (s.uses || []).filter((u) => u !== s.name && m.byName.has(u)),
            usedBy: m.usedBy.get(s.name),
        }));
        const simLinks = m.links.map((l) => ({ ...l }));
        const depLinks = m.deps.map((d) => ({ ...d }));
        const maxC = d3.max(nodes, (n) => n.consumers.size) || 1;
        const radius = d3.scaleSqrt().domain([0, maxC]).range([4, 14]);
        const r = (n) => radius(n.consumers.size);

        // pull each group towards its own centroid so clusters read as blobs
        function forceCluster(alpha) {
            const centroid = new Map();
            for (const n of nodes) {
                if (!n.group) continue;
                const c = centroid.get(n.group) || { x: 0, y: 0, k: 0 };
                c.x += n.x;
                c.y += n.y;
                c.k += 1;
                centroid.set(n.group, c);
            }
            for (const n of nodes) {
                const c = centroid.get(n.group);
                if (!c || c.k < 2) continue;
                n.vx += (c.x / c.k - n.x) * 0.12 * alpha;
                n.vy += (c.y / c.k - n.y) * 0.12 * alpha;
            }
        }

        const sim = d3
            .forceSimulation(nodes)
            .force('sim', d3.forceLink(simLinks).id((d) => d.id).distance(45).strength((l) => 0.3 + 0.7 * l.sim))
            .force('dep', d3.forceLink(depLinks).id((d) => d.id).distance(70).strength(0.2))
            .force('charge', d3.forceManyBody().strength(-160))
            .force('collide', d3.forceCollide((n) => r(n) + 6 + n.label.length * 1.5))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('x', d3.forceX(width / 2).strength(0.04))
            .force('y', d3.forceY(height / 2).strength(0.04))
            .force('cluster', forceCluster);

        const simLine = g.append('g').selectAll('line').data(simLinks).join('line').attr('class', 'sim-link').attr('stroke-width', (l) => 1 + 3 * l.sim);
        const depLine = g.append('g').selectAll('line').data(depLinks).join('line').attr('class', 'dep-link').attr('marker-end', 'url(#arrow)');

        const node = g
            .append('g')
            .selectAll('g')
            .data(nodes)
            .join('g')
            .attr('class', (n) => 'node symbol' + (n.group ? '' : ' unused'))
            .call(drag(sim));
        node.append('circle').attr('class', 'shape').attr('r', r).style('fill', (n) => (n.group ? colorOfGroup(n.group) : null));
        node.append('text').attr('dx', (n) => r(n) + 3).attr('dy', '0.35em').text((n) => n.label);

        function highlight(groupId, only) {
            const off = groupId == null && !only;
            node.classed('dim', (n) => !off && n !== only && (only ? true : n.group !== groupId));
            simLine.classed('dim', (l) => !off && (only ? true : l.source.group !== groupId || l.target.group !== groupId));
            depLine.classed('dim', (l) => !off && (only ? l.source !== only && l.target !== only : l.source.group !== groupId && l.target.group !== groupId));
            aside.selectAll('.group').classed('hot', (gr) => !off && gr && gr.id === groupId);
        }

        function nodeTip(n) {
            const files = [...n.consumers].sort();
            const shown = files.slice(0, 8).map((f) => `<code>${esc(f)}</code>`).join(', ') + (files.length > 8 ? `, … +${files.length - 8} more` : '');
            const parts = [`<div class="t-title">${esc(n.label)} <span class="t-muted">· ${n.group ? 'Group ' + n.group : 'unused'}</span></div>`];
            parts.push(`<div>needed by ${plural(n.consumers.size, 'file')}${n.direct.size !== n.consumers.size ? ` <span class="t-muted">(${n.direct.size} directly)</span>` : ''}</div>`);
            if (files.length) parts.push(`<div class="t-muted">${shown}</div>`);
            if (n.uses.length) parts.push(`<div>uses: ${n.uses.map(esc).join(', ')}</div>`);
            if (n.usedBy.length) parts.push(`<div>used by: ${n.usedBy.map(esc).join(', ')}</div>`);
            if (n.decl) parts.push(`<div class="t-muted">click to open <code>${esc(n.decl.file)}:${n.decl.line}</code></div>`);
            return parts.join('');
        }

        node.on('mouseenter', (event, n) => {
            if (n.group) highlight(n.group);
            else highlight(null, n);
            showTooltip(event, nodeTip(n));
        })
            .on('mousemove', moveTooltip)
            .on('mouseleave', () => {
                highlight(null);
                hideTooltip();
            })
            .on('click', (event, n) => {
                if (!event.defaultPrevented && n.decl) open(n.decl.file, n.decl.line);
            });

        simLine
            .on('mouseenter', (event, l) => {
                let inter = 0;
                for (const x of l.source.consumers) if (l.target.consumers.has(x)) inter++;
                showTooltip(event, `<div class="t-title">${esc(l.source.id)} ↔ ${esc(l.target.id)}</div><div>similarity ${l.sim.toFixed(2)} · ${plural(inter, 'shared consumer file')}</div>`);
            })
            .on('mousemove', moveTooltip)
            .on('mouseleave', hideTooltip);
        depLine
            .on('mouseenter', (event, l) => showTooltip(event, `<div class="t-title">${esc(l.source.id)} uses ${esc(l.target.id)}</div><div class="t-muted">${esc(l.target.id)}'s header must be included wherever ${esc(l.source.id)}'s is</div>`))
            .on('mousemove', moveTooltip)
            .on('mouseleave', hideTooltip);

        sim.on('tick', () => {
            simLine.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y).attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
            depLine.each(function (l) {
                // stop the arrow at the target's edge instead of under it
                const dx = l.target.x - l.source.x;
                const dy = l.target.y - l.source.y;
                const len = Math.hypot(dx, dy) || 1;
                const cut = r(l.target) + 2;
                d3.select(this)
                    .attr('x1', l.source.x)
                    .attr('y1', l.source.y)
                    .attr('x2', l.target.x - (dx / len) * cut)
                    .attr('y2', l.target.y - (dy / len) * cut);
            });
            node.attr('transform', (n) => `translate(${n.x},${n.y})`);
        });

        svg.call(d3.zoom().scaleExtent([0.2, 8]).on('zoom', (event) => g.attr('transform', event.transform))).on('dblclick.zoom', null);

        // the group list
        const openSymbol = (event, name) => {
            const s = m.byName.get(name);
            if (s && s.decl) open(s.decl.file, s.decl.line);
        };
        const groupSel = aside
            .selectAll('.group')
            .data(m.groups)
            .join('div')
            .attr('class', 'group')
            .on('mouseenter', (event, gr) => highlight(gr.id))
            .on('mouseleave', () => highlight(null));
        groupSel
            .append('div')
            .attr('class', 'group-title')
            .html((gr) => `<span class="swatch" style="background:${colorOfGroup(gr.id)}"></span>Group ${gr.id} <span class="t-muted">· ${plural(gr.names.length, 'symbol')} · ${plural(gr.files.length, 'file')}</span>`);
        groupSel
            .append('div')
            .attr('class', 'group-symbols')
            .selectAll('span')
            .data((gr) => gr.names)
            .join('span')
            .attr('class', 'chip')
            .attr('title', 'open declaration')
            .text((name) => name)
            .on('click', openSymbol);
        groupSel
            .append('div')
            .attr('class', 'group-files t-muted')
            .attr('title', (gr) => gr.files.join('\n'))
            .text((gr) => 'used by ' + gr.files.slice(0, 6).map(basename).join(', ') + (gr.files.length > 6 ? ` +${gr.files.length - 6} more` : ''));
        groupSel
            .filter((gr) => gr.dependsOn.size > 0)
            .append('div')
            .attr('class', 'group-deps t-muted')
            .text((gr) => 'needs group ' + [...gr.dependsOn].sort((a, b) => a - b).join(', '));
        if (m.unused.length) {
            const u = aside.append('div').attr('class', 'group').datum(null);
            u.append('div')
                .attr('class', 'group-title')
                .html(`<span class="swatch hollow"></span>Unused <span class="t-muted">· ${plural(m.unused.length, 'symbol')} · referenced nowhere outside ${esc(basename(m.file))}</span>`);
            u.append('div').attr('class', 'group-symbols').selectAll('span').data(m.unused).join('span').attr('class', 'chip').attr('title', 'open declaration').text((name) => name).on('click', openSymbol);
        }

        onResize = () => {
            const rr = graphEl.node().getBoundingClientRect();
            width = Math.max(100, rr.width);
            height = Math.max(100, rr.height);
            svg.attr('viewBox', [0, 0, width, height]);
            sim.force('center', d3.forceCenter(width / 2, height / 2))
                .force('x', d3.forceX(width / 2).strength(0.04))
                .force('y', d3.forceY(height / 2).strength(0.04))
                .alpha(0.2)
                .restart();
        };

        els.status.textContent =
            `${basename(m.file)} · ${plural(m.declared.length, 'symbol')} → ${plural(m.groups.length, 'group')}${m.unused.length ? ` + ${m.unused.length} unused` : ''}` +
            ` · grouped by shared consumer files (similarity ≥ ${threshold.toFixed(2)}${mergeDeps ? ', dependencies kept together' : ''}) · click a symbol to open its declaration`;

        const legend = m.groups.slice(0, DIR_COLORS.length).map((gr) => `<span class="legend-item"><span class="swatch" style="background:${colorOfGroup(gr.id)}"></span>Group ${gr.id}</span>`);
        if (m.groups.length > DIR_COLORS.length) legend.push(`<span class="legend-item"><span class="swatch" style="background:${OTHER_COLOR}"></span>groups ${DIR_COLORS.length + 1}–${m.groups.length}</span>`);
        if (m.unused.length) legend.push('<span class="legend-item"><span class="swatch hollow"></span>unused</span>');
        legend.push('<span class="legend-item"><span class="swatch line"></span>shared consumers</span>');
        legend.push('<span class="legend-item"><span class="swatch dashed"></span>uses →</span>');
        renderLegend(legend, false);
    }

    function planMarkdown(m) {
        const lines = [
            `# Split plan for ${m.file}`,
            '',
            `Grouped by shared consumer files (Jaccard ≥ ${threshold.toFixed(2)}${mergeDeps ? ', dependencies kept together' : ''}).`,
            '',
        ];
        for (const g of m.groups) {
            lines.push(`## Group ${g.id} — ${plural(g.names.length, 'symbol')}, used by ${plural(g.files.length, 'file')}`);
            lines.push(`- symbols: ${g.names.join(', ')}`);
            lines.push(`- used by: ${g.files.join(', ')}`);
            if (g.dependsOn.size) lines.push(`- needs: ${[...g.dependsOn].sort((a, b) => a - b).map((i) => 'group ' + i).join(', ')}`);
            lines.push('');
        }
        if (m.unused.length) {
            lines.push(`## Unused — ${plural(m.unused.length, 'symbol')} referenced nowhere outside ${m.file}`);
            lines.push(`- ${m.unused.join(', ')}`);
            lines.push('');
        }
        return lines.join('\n');
    }

    function copyPlan() {
        if (!data || view !== 'split' || !splitFile) return;
        const text = planMarkdown(splitModel());
        const clip = navigator.clipboard;
        const fallback = () => vscode.postMessage({ type: 'showPlan', text });
        if (clip && clip.writeText) {
            clip.writeText(text).then(() => flashStatus('Split plan copied to the clipboard'), fallback);
        } else {
            fallback();
        }
    }

    // ---------------------------------------------------------------- orchestration

    function render() {
        els.btnForce.classList.toggle('active', view === 'force');
        els.btnChord.classList.toggle('active', view === 'chord');
        els.btnSplit.classList.toggle('active', view === 'split');
        for (const el of [els.topFilesWrap, els.minSharedWrap]) el.style.display = view === 'chord' ? '' : 'none';
        for (const el of [els.splitFileWrap, els.thresholdWrap, els.mergeDepsWrap, els.btnCopyPlan]) el.style.display = view === 'split' ? '' : 'none';
        if (!data) {
            return;
        }
        if (view === 'force') {
            renderForce();
        } else if (view === 'chord') {
            renderChord();
        } else {
            renderSplit();
        }
    }

    function setView(v) {
        if (v !== 'force' && v !== 'chord' && v !== 'split') return;
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
    els.btnSplit.addEventListener('click', () => setView('split'));
    els.btnCopyPlan.addEventListener('click', copyPlan);

    els.splitFile.addEventListener('change', () => {
        splitFile = els.splitFile.value;
        saveState();
        render();
    });

    let thresholdTimer = 0;
    els.threshold.value = String(threshold);
    els.thresholdValue.textContent = threshold.toFixed(2);
    els.threshold.addEventListener('input', () => {
        threshold = parseFloat(els.threshold.value);
        els.thresholdValue.textContent = threshold.toFixed(2);
        window.clearTimeout(thresholdTimer);
        thresholdTimer = window.setTimeout(() => {
            saveState();
            render();
        }, 120);
    });

    els.mergeDeps.checked = mergeDeps;
    els.mergeDeps.addEventListener('change', () => {
        mergeDeps = els.mergeDeps.checked;
        saveState();
        render();
    });

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
                populateSplitFiles();
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
