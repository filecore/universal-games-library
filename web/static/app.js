let games = [];
let allStores = new Set();
let allPlatforms = new Set();
let allGenres = new Set();
let currentUser = null;

const STORE_LABELS = {
    bgg: "Boardgames",
    blizzard: "Blizzard",
    epic: "Epic Games",
    humble: "Humble Bundle",
    "meta-quest": "Meta Quest",
    "play-store": "Google Play",
    psn: "PSN",
    steam: "Steam",
    ubisoft: "Ubisoft",
};
const PLATFORM_LABELS = {
    pc: "PC",
    ps4: "PS4",
    ps5: "PS5",
    android: "Android",
    board: "Boardgame",
    quest2: "Meta Quest 2",
    switch: "Switch",
    xbox: "Xbox",
};
const labelStore = (s) => STORE_LABELS[s] || s;
const labelPlatform = (p) => PLATFORM_LABELS[p] || p;

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
        document.body.classList.add("logged-in");
        loadStatus();
    } else {
        area.innerHTML = `<button type="button" id="login-btn" class="link-btn">Log in</button>`;
        document.getElementById("login-btn").addEventListener("click", openLoginModal);
        mgmt.hidden = true;
        document.body.classList.remove("logged-in");
    }
    render();
}

function openLoginModal() {
    const modal = document.getElementById("login-modal");
    modal.classList.add("open");
    modal.hidden = false;
    document.getElementById("login-error").hidden = true;
    document.getElementById("login-username").value = "";
    document.getElementById("login-password").value = "";
    document.getElementById("login-username").focus();
}

function closeLoginModal() {
    const modal = document.getElementById("login-modal");
    modal.classList.remove("open");
    modal.hidden = true;
}

function sourceUrl(store, externalId, title) {
    const q = encodeURIComponent(title);
    switch (store) {
        case "steam":
            return externalId
                ? `https://store.steampowered.com/app/${externalId}`
                : `https://store.steampowered.com/search/?term=${q}`;
        case "bgg":
            return externalId
                ? `https://boardgamegeek.com/boardgame/${externalId}`
                : `https://boardgamegeek.com/geeksearch.php?action=search&q=${q}`;
        case "psn":
            return `https://store.playstation.com/en-us/search/${q}`;
        case "epic":
            return `https://store.epicgames.com/en-US/browse?q=${q}`;
        case "humble":
            return `https://www.humblebundle.com/store/search?search=${q}`;
        case "ubisoft":
            return `https://store.ubisoft.com/?q=${q}`;
        case "blizzard":
            return `https://us.shop.battle.net/search?q=${q}`;
        case "meta-quest":
            return `https://www.meta.com/experiences/search/?q=${q}`;
        case "play-store":
            return `https://play.google.com/store/search?q=${q}&c=apps`;
        default:
            return `https://www.google.com/search?q=${q}`;
    }
}

let currentModalGame = null;

function openGameModal(game) {
    currentModalGame = game;
    const m = document.getElementById("game-modal");
    document.getElementById("gm-title").textContent = game.title;
    const cover = document.getElementById("gm-cover");
    if (game.cover_url) {
        cover.style.backgroundImage = `url('${game.cover_url}')`;
        cover.classList.remove("empty");
    } else {
        cover.style.backgroundImage = "";
        cover.classList.add("empty");
    }
    const players =
        game.player_count_min && game.player_count_max
            ? game.player_count_min === game.player_count_max
                ? `${game.player_count_min}p`
                : `${game.player_count_min}-${game.player_count_max}p`
            : "";
    const yr = game.release_year ? `${game.release_year}` : "";
    const pt = formatPlaytime(game.playtime_minutes);
    document.getElementById("gm-meta").innerHTML =
        [yr, players, pt && `${pt} played`].filter(Boolean).join(" &middot; ");

    const tags = game.tags || [];
    const vrBadge = tags.includes("vr-only")
        ? `<span class="badge vr">VR</span>`
        : tags.includes("vr-mode")
          ? `<span class="badge vr-mode">VR mode</span>`
          : "";
    document.getElementById("gm-badges").innerHTML = vrBadge;
    document.getElementById("gm-genres").innerHTML =
        (game.genres || []).length
            ? (game.genres || [])
                  .map((g) => `<span class="genre-chip">${escapeHtml(g)}</span>`)
                  .join("")
            : "";

    // Ownership list, with per-row store link + playtime
    document.getElementById("gm-ownership").innerHTML = game.ownership
        .map((o) => {
            const link = sourceUrl(o.store, o.external_id, game.title);
            const pt2 = formatPlaytime(o.playtime_minutes);
            const ptStr = pt2 ? ` &middot; ${pt2}` : "";
            return `<li>
                <span class="badge ${escapeHtml(o.store)}">${escapeHtml(o.store.replace(/-/g, " "))}</span>
                <span class="ownership-plat">${escapeHtml(labelPlatform(o.platform))}</span>
                <span class="ownership-pt">${ptStr}</span>
                <a class="src-link" href="${link}" target="_blank" rel="noopener">View &rarr;</a>
            </li>`;
        })
        .join("");

    // Multiplayer pills (reuses existing renderer)
    document.getElementById("gm-pills").innerHTML = renderPillsInner(game);

    // Actions: IGDB link if igdb_id known
    const actions = document.getElementById("gm-actions");
    actions.innerHTML = "";
    if (game.cover_url || game.title) {
        const igdbSearch = `https://www.igdb.com/search?type=1&q=${encodeURIComponent(game.title)}`;
        actions.insertAdjacentHTML(
            "beforeend",
            `<a class="action-link" href="${igdbSearch}" target="_blank" rel="noopener">Search IGDB</a>`,
        );
    }

    // Editor (logged-in only)
    const editor = document.getElementById("gm-editor-wrap");
    if (currentUser) {
        editor.hidden = false;
        const f = document.getElementById("gm-edit-form");
        f.elements.title.value = game.title || "";
        f.elements.release_year.value = game.release_year || "";
        f.elements.cover_url.value = game.cover_url || "";
        f.elements.igdb_id.value = "";  // populated only if user wants to change
        f.elements.player_count_min.value = game.player_count_min || "";
        f.elements.player_count_max.value = game.player_count_max || "";
        f.elements.genres.value = (game.genres || []).join(", ");
        f.elements.tags.value = (game.tags || []).join(", ");
        f.dataset.gameId = game.id;
    } else {
        editor.hidden = true;
    }

    m.classList.add("open");
    m.hidden = false;
}

function closeGameModal() {
    const m = document.getElementById("game-modal");
    m.classList.remove("open");
    m.hidden = true;
    currentModalGame = null;
}

function renderPillsInner(g) {
    const editable = !!currentUser;
    const visible = editable ? MP_FLAGS : MP_FLAGS.filter((f) => g[f.key]);
    if (!visible.length) return "<span class=\"muted\">No multiplayer</span>";
    return visible
        .map(
            (f) =>
                `<span class="mp-pill ${g[f.key] ? "on" : ""}" data-game="${g.id}" data-flag="${f.key}">${f.label}</span>`,
        )
        .join("");
}

function openFilters() {
    document.getElementById("filters").classList.add("open");
    document.getElementById("filters-backdrop").classList.add("open");
}

function closeFilters() {
    document.getElementById("filters").classList.remove("open");
    document.getElementById("filters-backdrop").classList.remove("open");
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
    applyFiltersFromURL();
    render();
}

function serializeFilters() {
    const f = getFilters();
    const p = new URLSearchParams();
    if (f.search) p.set("q", f.search);
    if (f.stores.length) p.set("store", f.stores.join(","));
    if (f.platforms.length) p.set("platform", f.platforms.join(","));
    if (f.genres.length) p.set("genre", f.genres.join(","));
    if (f.pmin !== null) p.set("pmin", f.pmin);
    if (f.pmax !== null) p.set("pmax", f.pmax);
    if (f.localCoop) p.set("lcoop", "1");
    if (f.onlineCoop) p.set("ocoop", "1");
    if (f.localVs) p.set("lvs", "1");
    if (f.onlineVs) p.set("ovs", "1");
    if (f.digital) p.set("digital", "1");
    if (f.physical) p.set("physical", "1");
    if (f.includeExpansions) p.set("inc-exp", "1");
    if (f.vrOnly) p.set("vr-only", "1");
    if (f.vrSupported) p.set("vr-supp", "1");
    if (f.vrExclude) p.set("vr-no", "1");
    const sort = document.getElementById("f-sort")?.value;
    if (sort && sort !== "title") p.set("sort", sort);
    return p.toString();
}

function applyFiltersFromURL() {
    const p = new URLSearchParams(location.search);
    const searchEl = document.getElementById("f-search");
    searchEl.value = p.get("q") || "";

    const stores = (p.get("store") || "").split(",").filter(Boolean);
    document.querySelectorAll("#f-store input").forEach((cb) => {
        cb.checked = stores.includes(cb.dataset.store);
    });
    const platforms = (p.get("platform") || "").split(",").filter(Boolean);
    document.querySelectorAll("#f-platform input").forEach((cb) => {
        cb.checked = platforms.includes(cb.dataset.platform);
    });
    const genres = (p.get("genre") || "").split(",").filter(Boolean);
    document.querySelectorAll("#f-genre input").forEach((cb) => {
        cb.checked = genres.includes(cb.dataset.genre);
    });

    document.getElementById("f-pmin").value = p.get("pmin") || "";
    document.getElementById("f-pmax").value = p.get("pmax") || "";
    document.getElementById("f-local-coop").checked = p.get("lcoop") === "1";
    document.getElementById("f-online-coop").checked = p.get("ocoop") === "1";
    document.getElementById("f-local-vs").checked = p.get("lvs") === "1";
    document.getElementById("f-online-vs").checked = p.get("ovs") === "1";
    document.getElementById("f-digital").checked = p.get("digital") === "1";
    document.getElementById("f-physical").checked = p.get("physical") === "1";
    document.getElementById("f-include-expansions").checked =
        p.get("inc-exp") === "1";
    document.getElementById("f-vr-only").checked = p.get("vr-only") === "1";
    document.getElementById("f-vr-supported").checked = p.get("vr-supp") === "1";
    document.getElementById("f-vr-exclude").checked = p.get("vr-no") === "1";
    const sortEl = document.getElementById("f-sort");
    if (sortEl) sortEl.value = p.get("sort") || "title";

    // Expand any group that has an active filter so the user can see what's
    // selected when they land on a shared URL.
    const hasActive = {
        platform: platforms.length > 0,
        store: stores.length > 0,
        type:
            document.getElementById("f-digital").checked ||
            document.getElementById("f-physical").checked ||
            document.getElementById("f-include-expansions").checked,
        "player count":
            document.getElementById("f-pmin").value ||
            document.getElementById("f-pmax").value,
        multiplayer:
            document.getElementById("f-local-coop").checked ||
            document.getElementById("f-online-coop").checked ||
            document.getElementById("f-local-vs").checked ||
            document.getElementById("f-online-vs").checked,
        vr:
            document.getElementById("f-vr-only").checked ||
            document.getElementById("f-vr-supported").checked ||
            document.getElementById("f-vr-exclude").checked,
        genres: genres.length > 0,
    };
    document.querySelectorAll("#filters .filter-group").forEach((det) => {
        const summary = det.querySelector("summary")?.textContent?.trim().toLowerCase();
        if (hasActive[summary]) det.setAttribute("open", "");
    });

    if (typeof updateSearchClear === "function") updateSearchClear();
}

function updateURL() {
    const q = serializeFilters();
    const newURL = location.pathname + (q ? "?" + q : "");
    history.replaceState(null, "", newURL);
}

async function loadStatus() {
    const r = await fetch("/api/status");
    if (!r.ok) return;
    const s = await r.json();
    const block = document.getElementById("status-block");
    const bgg = s.bgg;
    const stores = s.stores || {};
    const pct = bgg.owned > 0 ? Math.round((bgg.with_cover / bgg.owned) * 100) : 0;
    const lastEnrich = bgg.last_enrich
        ? `<div class="last-run ${bgg.last_enrich.success ? "ok" : "fail"}">Last BGG enrich: ${escapeHtml(bgg.last_enrich.message || "")}</div>`
        : "";

    const storeRows = Object.entries(stores)
        .sort((a, b) => labelStore(a[0]).localeCompare(labelStore(b[0])))
        .map(
            ([store, count]) =>
                `<div class="stat-row"><span>${escapeHtml(labelStore(store))}</span><b>${count}</b></div>`,
        )
        .join("");

    const expansionLine = bgg.expansions
        ? `<div class="stat-row sub"><span>+ Boardgame expansions</span><b>${bgg.expansions}</b></div>`
        : "";
    block.innerHTML = `
        ${storeRows}
        ${expansionLine}
        ${lastEnrich}
    `;
}

function buildFacets() {
    const storeCounts = new Map();
    const platformCounts = new Map();
    const genreCounts = new Map();
    for (const g of games) {
        const seenStores = new Set();
        const seenPlatforms = new Set();
        for (const o of g.ownership) {
            if (!seenStores.has(o.store)) {
                seenStores.add(o.store);
                storeCounts.set(o.store, (storeCounts.get(o.store) || 0) + 1);
            }
            if (!seenPlatforms.has(o.platform)) {
                seenPlatforms.add(o.platform);
                platformCounts.set(
                    o.platform,
                    (platformCounts.get(o.platform) || 0) + 1,
                );
            }
        }
        for (const genre of g.genres || []) {
            genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
        }
    }

    const sortedStores = [...allStores].sort((a, b) =>
        labelStore(a).localeCompare(labelStore(b)),
    );
    const storeBox = document.getElementById("f-store");
    storeBox.innerHTML = sortedStores
        .map(
            (s) =>
                `<label><input type="checkbox" data-store="${s}"> ${escapeHtml(labelStore(s))} (${storeCounts.get(s) || 0})</label>`,
        )
        .join("");

    const sortedPlatforms = [...allPlatforms].sort((a, b) =>
        labelPlatform(a).localeCompare(labelPlatform(b)),
    );
    const platBox = document.getElementById("f-platform");
    platBox.innerHTML = sortedPlatforms
        .map(
            (p) =>
                `<label><input type="checkbox" data-platform="${p}"> ${escapeHtml(labelPlatform(p))} (${platformCounts.get(p) || 0})</label>`,
        )
        .join("");

    const sortedGenres = [...allGenres].sort();
    const genreBox = document.getElementById("f-genre");
    genreBox.innerHTML = sortedGenres
        .map(
            (g) =>
                `<label><input type="checkbox" data-genre="${escapeHtml(g)}"> ${escapeHtml(g)} (${genreCounts.get(g) || 0})</label>`,
        )
        .join("");
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
        includeExpansions: document.getElementById("f-include-expansions").checked,
        vrOnly: document.getElementById("f-vr-only").checked,
        vrSupported: document.getElementById("f-vr-supported").checked,
        vrExclude: document.getElementById("f-vr-exclude").checked,
    };
}

function matches(g, f) {
    if (!f.includeExpansions && (g.tags || []).includes("expansion")) return false;
    const tags = g.tags || [];
    if (f.vrOnly && !tags.includes("vr-only")) return false;
    if (f.vrSupported && !tags.includes("vr-only") && !tags.includes("vr-mode"))
        return false;
    if (f.vrExclude && (tags.includes("vr-only") || tags.includes("vr-mode")))
        return false;
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

const MP_FLAGS = [
    { key: "has_local_coop", label: "L-coop" },
    { key: "has_online_coop", label: "O-coop" },
    { key: "has_local_vs", label: "L-vs" },
    { key: "has_online_vs", label: "O-vs" },
];

function renderPills(g) {
    const editable = !!currentUser;
    const visible = editable
        ? MP_FLAGS
        : MP_FLAGS.filter((f) => g[f.key]);
    if (!visible.length) return "";
    return `<div class="mp-pills">${visible
        .map(
            (f) =>
                `<span class="mp-pill ${g[f.key] ? "on" : ""}" data-game="${g.id}" data-flag="${f.key}">${f.label}</span>`,
        )
        .join("")}</div>`;
}

function sortGames(arr) {
    const mode = document.getElementById("f-sort")?.value || "title";
    const titleCmp = (a, b) =>
        a.title.toLowerCase().localeCompare(b.title.toLowerCase());
    if (mode === "title")
        return [...arr].sort(titleCmp);
    if (mode === "title-desc")
        return [...arr].sort((a, b) => titleCmp(b, a));
    if (mode === "year-desc")
        return [...arr].sort((a, b) => (b.release_year || 0) - (a.release_year || 0) || titleCmp(a, b));
    if (mode === "year-asc")
        return [...arr].sort((a, b) => (a.release_year || 9999) - (b.release_year || 9999) || titleCmp(a, b));
    if (mode === "played-desc")
        return [...arr].sort((a, b) => (b.playtime_minutes || 0) - (a.playtime_minutes || 0) || titleCmp(a, b));
    if (mode === "played-asc") {
        // Games with no playtime info go last; among tracked ones, lowest first
        return [...arr].sort((a, b) => {
            const aHas = a.playtime_minutes != null;
            const bHas = b.playtime_minutes != null;
            if (aHas !== bHas) return aHas ? -1 : 1;
            return (a.playtime_minutes || 0) - (b.playtime_minutes || 0) || titleCmp(a, b);
        });
    }
    return arr;
}

function formatPlaytime(minutes) {
    if (minutes == null) return "";
    if (minutes < 1) return "&lt;1m";
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

function render() {
    const f = getFilters();
    const m = document.getElementById("games");
    const filtered = sortGames(games.filter((g) => matches(g, f)));
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
            const pt = formatPlaytime(g.playtime_minutes);
            const ptStr = pt ? ` &middot; ${pt} played` : "";
            const meta = `${players}${year}${ptStr}`;
            const tags = g.tags || [];
            const vrBadge = tags.includes("vr-only")
                ? `<span class="badge vr">VR</span>`
                : tags.includes("vr-mode")
                  ? `<span class="badge vr-mode">VR mode</span>`
                  : "";
            const storesByCard = new Map();
            for (const o of g.ownership) {
                if (!storesByCard.has(o.store)) storesByCard.set(o.store, new Set());
                storesByCard.get(o.store).add(o.platform);
            }
            const badgeParts = [];
            for (const [store, plats] of storesByCard) {
                const storeLabel = store.replace(/-/g, " ");
                if (plats.size === 1) {
                    const plat = [...plats][0];
                    const tip = `${labelStore(store)} (${labelPlatform(plat)})`;
                    badgeParts.push(
                        `<span class="badge ${escapeHtml(store)}" title="${escapeHtml(tip)}">${escapeHtml(storeLabel)}</span>`,
                    );
                } else {
                    // Multiple platforms in one store - one badge per platform
                    for (const plat of [...plats].sort()) {
                        const tip = `${labelStore(store)} (${labelPlatform(plat)})`;
                        const text = `${storeLabel} ${labelPlatform(plat)}`;
                        badgeParts.push(
                            `<span class="badge ${escapeHtml(store)}" title="${escapeHtml(tip)}">${escapeHtml(text)}</span>`,
                        );
                    }
                }
            }
            const badges = badgeParts.join("") + vrBadge;
            return `<div class="card" data-game-id="${g.id}">
            ${cover}
            <div class="body">
                <div class="title">${escapeHtml(g.title)}</div>
                <div class="meta">${meta}</div>
                <div class="badges">${badges}</div>
                ${renderPills(g)}
            </div>
        </div>`;
        })
        .join("");
    document.getElementById("stats").textContent =
        `${filtered.length} / ${games.length} games`;
}

document.getElementById("games").addEventListener("click", async (ev) => {
    const pill = ev.target.closest(".mp-pill");
    if (pill) {
        if (!currentUser) return;
        ev.stopPropagation();
        const gameId = parseInt(pill.dataset.game, 10);
        const flag = pill.dataset.flag;
        const game = games.find((g) => g.id === gameId);
        if (!game) return;
        const newValue = !game[flag];
        game[flag] = newValue;
        pill.classList.toggle("on", newValue);
        const r = await fetch(`/api/games/${gameId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [flag]: newValue }),
        });
        if (!r.ok) {
            game[flag] = !newValue;
            pill.classList.toggle("on", !newValue);
        }
        return;
    }
    const card = ev.target.closest(".card");
    if (!card) return;
    const gameId = parseInt(card.dataset.gameId, 10);
    const game = games.find((g) => g.id === gameId);
    if (game) openGameModal(game);
});

document.getElementById("game-modal-close").addEventListener("click", closeGameModal);
document.getElementById("game-modal").addEventListener("click", (ev) => {
    if (ev.target.id === "game-modal") closeGameModal();
});
document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
        if (!document.getElementById("game-modal").hidden) closeGameModal();
    }
});

// Pills inside the modal also need to toggle
document.getElementById("gm-pills").addEventListener("click", async (ev) => {
    const pill = ev.target.closest(".mp-pill");
    if (!pill || !currentUser || !currentModalGame) return;
    const gameId = parseInt(pill.dataset.game, 10);
    const flag = pill.dataset.flag;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;
    const newValue = !game[flag];
    game[flag] = newValue;
    pill.classList.toggle("on", newValue);
    const r = await fetch(`/api/games/${gameId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [flag]: newValue }),
    });
    if (!r.ok) {
        game[flag] = !newValue;
        pill.classList.toggle("on", !newValue);
    } else {
        render();
    }
});

// Editor save
document.getElementById("gm-edit-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!currentModalGame) return;
    const f = ev.target;
    const payload = {};
    const map = {
        title: "title",
        release_year: "release_year",
        cover_url: "cover_url",
        igdb_id: "igdb_id",
        player_count_min: "player_count_min",
        player_count_max: "player_count_max",
        genres: "genres",
        tags: "tags",
    };
    for (const [name, key] of Object.entries(map)) {
        const v = f.elements[name].value.trim();
        if (key === "igdb_id" && !v) continue;  // empty igdb means keep
        if (v === "" && (key === "release_year" || key === "player_count_min" || key === "player_count_max")) continue;
        payload[key] = v;
    }
    const r = await fetch(`/api/games/${currentModalGame.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!r.ok) {
        alert("Save failed: HTTP " + r.status);
        return;
    }
    await loadGames();
    const updated = games.find((g) => g.id === currentModalGame.id);
    if (updated) openGameModal(updated);
});

document.getElementById("gm-refetch").addEventListener("click", async () => {
    if (!currentModalGame) return;
    const r = await fetch(`/api/games/${currentModalGame.id}/refetch-igdb`, {
        method: "POST",
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert("Re-fetch failed: " + (j.detail || r.status));
        return;
    }
    await loadGames();
    const updated = games.find((g) => g.id === currentModalGame.id);
    if (updated) openGameModal(updated);
});

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

function renderAndPersist() {
    render();
    updateURL();
}
["input", "change"].forEach((ev) => {
    document.getElementById("filters").addEventListener(ev, renderAndPersist);
});
document.getElementById("f-sort").addEventListener("change", renderAndPersist);

document.getElementById("filters-toggle").addEventListener("click", openFilters);
document.getElementById("filters-close").addEventListener("click", closeFilters);
document.getElementById("filters-backdrop").addEventListener("click", closeFilters);

const searchInput = document.getElementById("f-search");
const searchClear = document.getElementById("f-search-clear");
function updateSearchClear() {
    searchClear.hidden = !searchInput.value;
}
searchInput.addEventListener("input", updateSearchClear);
searchClear.addEventListener("click", () => {
    searchInput.value = "";
    updateSearchClear();
    render();
    updateURL();
    searchInput.focus();
});

async function loadSnippet() {
    try {
        const r = await fetch("/static/bgg-scrape.js?t=" + Date.now(), {
            cache: "no-cache",
        });
        const code = await r.text();
        const ta = document.getElementById("snippet-source");
        if (ta) ta.value = code.trim();
    } catch {}
}

document.getElementById("copy-snippet").addEventListener("click", async () => {
    const ta = document.getElementById("snippet-source");
    ta.select();
    try {
        await navigator.clipboard.writeText(ta.value);
        const s = document.getElementById("ingest-status");
        s.textContent = "Snippet copied. Paste into BGG DevTools console.";
    } catch {
        document.execCommand("copy");
    }
});

loadSnippet();

(async () => {
    await loadMe();
    await loadGames();
})();
