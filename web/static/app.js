let games = [];
let allStores = new Set();
let allPlatforms = new Set();
let allGenres = new Set();
let currentUser = null;

async function loadMe() {
    const r = await fetch("/api/me");
    const j = await r.json();
    currentUser = j.user || null;
    renderAuthArea();
}

function renderAuthArea() {
    const area = document.getElementById("auth-area");
    const mgmt = document.getElementById("management");
    if (currentUser) {
        area.innerHTML = `Logged in as <b>${escapeHtml(currentUser)}</b> <button type="button" id="logout-btn" class="link-btn">Log out</button>`;
        document.getElementById("logout-btn").addEventListener("click", logout);
        mgmt.hidden = false;
        loadStatus();
    } else {
        area.innerHTML = `<button type="button" id="login-btn" class="link-btn">Log in</button>`;
        document.getElementById("login-btn").addEventListener("click", openLoginModal);
        mgmt.hidden = true;
    }
}

function openLoginModal() {
    document.getElementById("login-modal").hidden = false;
    document.getElementById("login-error").hidden = true;
    document.getElementById("login-username").value = "";
    document.getElementById("login-password").value = "";
    document.getElementById("login-username").focus();
}

function closeLoginModal() {
    document.getElementById("login-modal").hidden = true;
}

async function logout() {
    await fetch("/api/logout", { method: "POST" });
    currentUser = null;
    renderAuthArea();
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

async function loadStatus() {
    const r = await fetch("/api/status");
    if (!r.ok) return;
    const s = await r.json();
    const block = document.getElementById("status-block");
    const bgg = s.bgg;
    const steam = s.steam;
    const pct = bgg.owned > 0 ? Math.round((bgg.with_cover / bgg.owned) * 100) : 0;
    const lastEnrich = bgg.last_enrich
        ? `<div class="last-run ${bgg.last_enrich.success ? "ok" : "fail"}">Last enrich: ${escapeHtml(bgg.last_enrich.message || "")}</div>`
        : `<div class="last-run">Never enriched</div>`;
    block.innerHTML = `
        <div class="stat-row"><span>Steam owned</span><b>${steam.owned}</b></div>
        <div class="stat-row"><span>BGG owned</span><b>${bgg.owned}</b></div>
        <div class="stat-row"><span>BGG with covers</span><b>${bgg.with_cover} / ${bgg.owned}</b></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        ${lastEnrich}
    `;
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
    return (s || "").toString().replace(/[&<>"']/g, (c) =>
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

async function ingest(source) {
    const s = document.getElementById("ingest-status");
    s.textContent = `Running ${source}...`;
    const r = await fetch(`/api/ingest/${source}`, { method: "POST" });
    if (r.status === 401) {
        s.textContent = "Session expired. Please log in again.";
        currentUser = null;
        renderAuthArea();
        return;
    }
    const result = await r.json();
    s.textContent = result.message;
    if (result.success) {
        await loadGames();
        await loadStatus();
    }
}

async function enrichBggImages() {
    const s = document.getElementById("ingest-status");
    s.textContent = "Enriching BGG covers...";
    const r = await fetch("/api/enrich/bgg-images", { method: "POST" });
    if (r.status === 401) {
        s.textContent = "Session expired. Please log in again.";
        currentUser = null;
        renderAuthArea();
        return;
    }
    const result = await r.json();
    s.textContent = result.message;
    await loadStatus();
    if (result.success) await loadGames();
}

document.getElementById("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const r = await fetch("/api/login", { method: "POST", body: fd });
    if (!r.ok) {
        const err = document.getElementById("login-error");
        err.textContent = "Incorrect username or password.";
        err.hidden = false;
        return;
    }
    const j = await r.json();
    currentUser = j.user;
    closeLoginModal();
    renderAuthArea();
});

document.getElementById("login-cancel").addEventListener("click", closeLoginModal);
document.getElementById("login-modal").addEventListener("click", (ev) => {
    if (ev.target.id === "login-modal") closeLoginModal();
});
document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !document.getElementById("login-modal").hidden) {
        closeLoginModal();
    }
});

// Management buttons (only active when logged in; section is hidden otherwise)
document.getElementById("run-steam").addEventListener("click", () => ingest("steam"));
document.getElementById("run-bgg").addEventListener("click", () => ingest("bgg"));
document.getElementById("enrich-bgg-images").addEventListener("click", enrichBggImages);

document.getElementById("manual-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const store = fd.get("store");
    const file = fd.get("file");
    if (!file || !file.name) {
        document.getElementById("ingest-status").textContent = "Choose a file first.";
        return;
    }
    const upload = new FormData();
    upload.append("file", file);
    const s = document.getElementById("ingest-status");
    s.textContent = `Uploading ${file.name}...`;
    const r = await fetch(
        `/api/ingest/manual?store=${encodeURIComponent(store)}`,
        { method: "POST", body: upload },
    );
    if (r.status === 401) {
        s.textContent = "Session expired. Please log in again.";
        currentUser = null;
        renderAuthArea();
        return;
    }
    const result = await r.json();
    s.textContent = result.message;
    if (result.success) {
        await loadGames();
        await loadStatus();
    }
});

["input", "change"].forEach((ev) => {
    document.getElementById("filters").addEventListener(ev, render);
});

(async () => {
    await loadMe();
    await loadGames();
})();
