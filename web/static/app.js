let games = [];
let allStores = new Set();
let allPlatforms = new Set();
let allGenres = new Set();
let ingestProtected = false;

function ingestHeaders() {
    if (!ingestProtected) return {};
    const t = localStorage.getItem("ingestToken") || "";
    return t ? { "X-Ingest-Token": t } : {};
}

async function loadConfig() {
    try {
        const r = await fetch("/api/config");
        const c = await r.json();
        ingestProtected = !!c.ingest_protected;
    } catch {
        ingestProtected = false;
    }
}

async function loadGames() {
    const r = await fetch("/api/games");
    games = await r.json();
    allStores = new Set();
    allPlatforms = new Set();
    allGenres = new Set();
    for (const g of games) {
        for (const o of g.ownership) {
            allStores.add(o.store);
            allPlatforms.add(o.platform);
        }
        for (const genre of g.genres || []) allGenres.add(genre);
    }
    buildFacets();
    render();
}

function buildFacets() {
    const storeBox = document.getElementById("f-store");
    storeBox.innerHTML = "";
    [...allStores].sort().forEach((s) => {
        storeBox.insertAdjacentHTML(
            "beforeend",
            `<label><input type="checkbox" data-store="${s}"> ${s}</label>`,
        );
    });
    const platBox = document.getElementById("f-platform");
    platBox.innerHTML = "";
    [...allPlatforms].sort().forEach((p) => {
        platBox.insertAdjacentHTML(
            "beforeend",
            `<label><input type="checkbox" data-platform="${p}"> ${p}</label>`,
        );
    });
    const genreBox = document.getElementById("f-genre");
    genreBox.innerHTML = "";
    [...allGenres].sort().forEach((g) => {
        genreBox.insertAdjacentHTML(
            "beforeend",
            `<label><input type="checkbox" data-genre="${g}"> ${g}</label>`,
        );
    });
}

function getFilters() {
    return {
        search: document.getElementById("f-search").value.trim().toLowerCase(),
        stores: [...document.querySelectorAll("#f-store input:checked")].map(
            (e) => e.dataset.store,
        ),
        platforms: [...document.querySelectorAll("#f-platform input:checked")].map(
            (e) => e.dataset.platform,
        ),
        genres: [...document.querySelectorAll("#f-genre input:checked")].map(
            (e) => e.dataset.genre,
        ),
        pmin: parseInt(document.getElementById("f-pmin").value, 10) || null,
        pmax: parseInt(document.getElementById("f-pmax").value, 10) || null,
        localCoop: document.getElementById("f-local-coop").checked,
        onlineCoop: document.getElementById("f-online-coop").checked,
        localVs: document.getElementById("f-local-vs").checked,
        onlineVs: document.getElementById("f-online-vs").checked,
        digital: document.getElementById("f-digital").checked,
        physical: document.getElementById("f-physical").checked,
    };
}

function matches(g, f) {
    if (f.search && !g.title.toLowerCase().includes(f.search)) return false;
    if (f.stores.length && !g.ownership.some((o) => f.stores.includes(o.store)))
        return false;
    if (
        f.platforms.length &&
        !g.ownership.some((o) => f.platforms.includes(o.platform))
    )
        return false;
    if (f.genres.length && !(g.genres || []).some((x) => f.genres.includes(x)))
        return false;
    if (f.pmin !== null && (g.player_count_max || 1) < f.pmin) return false;
    if (f.pmax !== null && (g.player_count_min || 1) > f.pmax) return false;
    if (f.localCoop && !g.has_local_coop) return false;
    if (f.onlineCoop && !g.has_online_coop) return false;
    if (f.localVs && !g.has_local_vs) return false;
    if (f.onlineVs && !g.has_online_vs) return false;
    if (f.digital && !g.ownership.some((o) => !o.is_physical)) return false;
    if (f.physical && !g.ownership.some((o) => o.is_physical)) return false;
    return true;
}

function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
}

function render() {
    const f = getFilters();
    const m = document.getElementById("games");
    const filtered = games.filter((g) => matches(g, f));
    m.innerHTML = filtered
        .map((g) => {
            const cover = g.cover_url
                ? `<div class="cover" style="background-image:url('${g.cover_url}')"></div>`
                : `<div class="cover"></div>`;
            const players =
                g.player_count_min && g.player_count_max
                    ? g.player_count_min === g.player_count_max
                        ? `${g.player_count_min}p`
                        : `${g.player_count_min}-${g.player_count_max}p`
                    : "";
            const year = g.release_year ? ` &middot; ${g.release_year}` : "";
            const meta = `${players}${year}`;
            const badges = g.ownership
                .map(
                    (o) =>
                        `<span class="badge ${escapeHtml(o.store)}">${escapeHtml(o.store)}</span>`,
                )
                .join("");
            return `<div class="card">
            ${cover}
            <div class="body">
                <div class="title">${escapeHtml(g.title)}</div>
                <div class="meta">${meta}</div>
                <div class="badges">${badges}</div>
            </div>
        </div>`;
        })
        .join("");
    document.getElementById("stats").textContent =
        `${filtered.length} / ${games.length} games`;
}

function maybePromptForToken() {
    if (!ingestProtected) return true;
    let t = localStorage.getItem("ingestToken");
    if (!t) {
        t = prompt("Enter ingest token (set via INGEST_TOKEN in .env):") || "";
        if (!t) return false;
        localStorage.setItem("ingestToken", t);
    }
    return true;
}

async function ingest(source) {
    if (!maybePromptForToken()) return;
    const s = document.getElementById("ingest-status");
    s.textContent = `Running ${source}...`;
    const r = await fetch(`/api/ingest/${source}`, {
        method: "POST",
        headers: ingestHeaders(),
    });
    if (r.status === 401) {
        localStorage.removeItem("ingestToken");
        s.textContent = "Ingest token rejected.";
        return;
    }
    const result = await r.json();
    s.textContent = result.message;
    if (result.success) await loadGames();
}

document.getElementById("run-steam").addEventListener("click", () => ingest("steam"));
document.getElementById("run-bgg").addEventListener("click", () => ingest("bgg"));

document.getElementById("manual-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!maybePromptForToken()) return;
    const fd = new FormData(ev.target);
    const store = fd.get("store");
    const file = fd.get("file");
    if (!file || !file.name) {
        document.getElementById("ingest-status").textContent =
            "Choose a file first.";
        return;
    }
    const upload = new FormData();
    upload.append("file", file);
    const s = document.getElementById("ingest-status");
    s.textContent = `Uploading ${file.name}...`;
    const r = await fetch(
        `/api/ingest/manual?store=${encodeURIComponent(store)}`,
        { method: "POST", body: upload, headers: ingestHeaders() },
    );
    if (r.status === 401) {
        localStorage.removeItem("ingestToken");
        s.textContent = "Ingest token rejected.";
        return;
    }
    const result = await r.json();
    s.textContent = result.message;
    if (result.success) await loadGames();
});

["input", "change"].forEach((ev) => {
    document.getElementById("filters").addEventListener(ev, render);
});

(async () => {
    await loadConfig();
    await loadGames();
})();
