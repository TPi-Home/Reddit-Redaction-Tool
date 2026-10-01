// ==UserScript==
// @name         Reddit Comment Redactor
// @namespace    local.reddit.comment-redactor
// @version      1.0.0
// @description  Dry-run and batch-redact your Reddit comments.
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      www.reddit.com
// @connect      old.reddit.com
// ==/UserScript==

(() => {
    "use strict";

    const CONFIG = {
        replacement: "Redacted my comments. ",
        pageSize: 100,
        batchSize: 10,
        delayMs: 2000,
    };

    let comments = [];
    let scanning = false;
    let redacting = false;

    const sleep = (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms));

    function redditBase() {
        return location.hostname === "old.reddit.com"
            ? "https://old.reddit.com"
            : "https://www.reddit.com";
    }

    function request(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method ?? "GET",
                url,
                headers: options.headers ?? {},
                data: options.body,
                responseType: "json",

                onload(response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(
                            new Error(
                                `HTTP ${response.status} from ${url}`
                            )
                        );
                    }
                },

                onerror() {
                    reject(
                        new Error(`Network error requesting ${url}`)
                    );
                },
            });
        });
    }

    async function getCurrentUser() {
        const response = await request(
            `${redditBase()}/api/me.json`
        );

        const user = response.response?.data;

        if (!user?.name) {
            throw new Error(
                "You are not logged into Reddit."
            );
        }

        if (!user.modhash) {
            throw new Error(
                "Reddit did not provide a session modhash."
            );
        }

        return user;
    }

    async function getComments(username) {
        const result = [];

        let after = null;

        while (true) {
            const params = new URLSearchParams({
                limit: String(CONFIG.pageSize),
            });

            if (after) {
                params.set("after", after);
            }

            const url =
                `${redditBase()}/user/` +
                `${encodeURIComponent(username)}` +
                `/comments.json?${params}`;

            const response = await request(url);

            const listing =
                response.response?.data;

            if (!listing?.children) {
                throw new Error(
                    "Reddit returned an invalid comment listing."
                );
            }

            for (const child of listing.children) {
                if (child.kind !== "t1") {
                    continue;
                }

                const comment = child.data;

                if (
                    typeof comment.body !== "string" ||
                    !comment.body.trim()
                ) {
                    continue;
                }

                /*
                 * Already-redacted comments are not displayed
                 * or offered for editing.
                 */
               if (
                  comment.body.trim() ===
                  CONFIG.replacement
                ) {
                    continue;
                }

                result.push({
                    id: comment.name,
                    body: comment.body,
                    subreddit:
                        comment.subreddit_name_prefixed ??
                        `r/${comment.subreddit}`,
                    created: new Date(
                        comment.created_utc * 1000
                    ),
                    score: comment.score,
                    url:
                        `${redditBase()}${comment.permalink}`,
                });
            }

            after = listing.after;

            if (!after || listing.children.length === 0) {
                break;
            }

            await sleep(250);
        }

        return result;
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function formatDate(date) {
        return date.toLocaleString();
    }

    function setStatus(text) {
        const element =
            document.querySelector("#rcr-status");

        if (element) {
            element.textContent = text;
        }
    }

    function selectedComments() {
        return [
            ...document.querySelectorAll(
                ".rcr-checkbox:checked"
            ),
        ].map(
            (checkbox) =>
                comments[
                    Number(checkbox.dataset.index)
                ]
        );
    }

    function renderComments() {
        const list =
            document.querySelector("#rcr-list");

        list.innerHTML = "";

        if (!comments.length) {
            list.innerHTML = `
                <div class="rcr-empty">
                    No comments found that need redaction.
                </div>
            `;

            updateButtons();
            return;
        }

        for (const [index, comment] of comments.entries()) {
            const row =
                document.createElement("div");

            row.className = "rcr-item";

            row.innerHTML = `
                <input
                    type="checkbox"
                    class="rcr-checkbox"
                    data-index="${index}"
                    checked
                >

                <div class="rcr-content">
                    <div class="rcr-meta">
                        <strong>
                            ${escapeHtml(comment.subreddit)}
                        </strong>

                        <span>
                            ${escapeHtml(
                                formatDate(comment.created)
                            )}
                        </span>

                        <span>
                            score: ${escapeHtml(comment.score)}
                        </span>
                    </div>

                    <div class="rcr-body">
                        ${escapeHtml(comment.body)}
                    </div>

                    <a
                        href="${escapeHtml(comment.url)}"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open comment
                    </a>
                </div>
            `;

            list.appendChild(row);
        }

        updateButtons();
    }

    function updateButtons() {
        const hasComments =
            comments.length > 0;

        const scan =
            document.querySelector("#rcr-scan");

        const redact =
            document.querySelector("#rcr-redact");

        const select =
            document.querySelector("#rcr-select");

        const clear =
            document.querySelector("#rcr-clear");

        if (scan) {
            scan.disabled =
                scanning || redacting;
        }

        if (redact) {
            redact.disabled =
                !hasComments || redacting;
        }

        if (select) {
            select.disabled =
                !hasComments || redacting;
        }

        if (clear) {
            clear.disabled =
                !hasComments || redacting;
        }
    }

    async function scan() {
        if (scanning || redacting) {
            return;
        }

        scanning = true;
        updateButtons();

        try {
            setStatus(
                "Checking Reddit login..."
            );

            const user =
                await getCurrentUser();

            setStatus(
                `Scanning comments for u/${user.name}...`
            );

            comments =
                await getComments(user.name);

            comments.sort(
                (a, b) =>
                    b.created.getTime() -
                    a.created.getTime()
            );

            renderComments();

            setStatus(
                `Dry run complete: ${comments.length} ` +
                `comments found. Nothing changed.`
            );
        } catch (error) {
            console.error(error);

            setStatus(
                `ERROR: ${error.message}`
            );
        } finally {
            scanning = false;
            updateButtons();
        }
    }

    async function redactComment(
        comment,
        modhash
    ) {
        const body =
            new URLSearchParams({
                api_type: "json",
                text: CONFIG.replacement,
                thing_id: comment.id,
                uh: modhash,
            });

        const response = await request(
            `${redditBase()}/api/editusertext`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },

                body: body.toString(),
            }
        );

        /*
         * Reddit can return HTTP 200 while reporting
         * an API-level error.
         */
        const errors =
            response.response?.json?.errors ??
            response.response?.data?.json?.errors ??
            [];

        if (errors.length) {
            throw new Error(
                `Reddit rejected the edit: ` +
                JSON.stringify(errors)
            );
        }
    }

    async function redactSelected() {
        if (redacting) {
            return;
        }

        const selected =
            selectedComments();

        if (!selected.length) {
            alert(
                "No comments are selected."
            );

            return;
        }

        const confirmation = confirm(
            `Redact ${selected.length} comments?\n\n` +
            `Each selected comment will be replaced with:\n\n` +
            `"${CONFIG.replacement}"\n\n` +
            `The redacted comments will remain on Reddit.`
        );

        if (!confirmation) {
            return;
        }

        redacting = true;
        updateButtons();

        const batchSize = Math.max(
            1,
            Math.min(
                50,
                Number(
                    document.querySelector(
                        "#rcr-batch"
                    ).value
                ) || CONFIG.batchSize
            )
        );

        const delayMs = Math.max(
            500,
            Math.min(
                30000,
                Number(
                    document.querySelector(
                        "#rcr-delay"
                    ).value
                ) || CONFIG.delayMs
            )
        );

        let successful = 0;
        let failed = 0;

        try {
            /*
             * This is only used to authenticate the edit.
             *
             * No API credentials are created or stored.
             */
            const user =
                await getCurrentUser();

            const modhash =
                user.modhash;

            for (
                let offset = 0;
                offset < selected.length;
                offset += batchSize
            ) {
                const batch =
                    selected.slice(
                        offset,
                        offset + batchSize
                    );

                const batchNumber =
                    Math.floor(
                        offset / batchSize
                    ) + 1;

                setStatus(
                    `Batch ${batchNumber}: ` +
                    `redacting ${batch.length} comments...`
                );

                for (const comment of batch) {
                    try {
                        await redactComment(
                            comment,
                            modhash
                        );

                        successful++;

                        /*
                         * Remove the successfully processed
                         * comment from the local dry-run list.
                         *
                         * The original body is therefore no
                         * longer retained by this script.
                         */
                        const index =
                            comments.indexOf(
                                comment
                            );

                        if (index !== -1) {
                            comments.splice(
                                index,
                                1
                            );
                        }

                        renderComments();

                        await sleep(
                            delayMs
                        );
                    } catch (error) {
                        failed++;

                        console.error(
                            "Redaction failed:",
                            comment.id,
                            error
                        );

                        setStatus(
                            `Failed ${comment.id}: ` +
                            `${error.message}`
                        );

                        await sleep(
                            delayMs * 2
                        );
                    }
                }

                if (
                    offset + batchSize <
                    selected.length
                ) {
                    setStatus(
                        `Batch ${batchNumber} complete. ` +
                        `Redacted ${successful}; ` +
                        `failed ${failed}. ` +
                        `Waiting...`
                    );

                    await sleep(
                        delayMs * 2
                    );
                }
            }

            setStatus(
                `Finished. ` +
                `Redacted ${successful}; ` +
                `failed ${failed}.`
            );
        } catch (error) {
            console.error(error);

            setStatus(
                `STOPPED: ${error.message}. ` +
                `Redacted ${successful}; ` +
                `failed ${failed}.`
            );
        } finally {
            redacting = false;
            updateButtons();
        }
    }

    function selectAll() {
        for (
            const checkbox of
            document.querySelectorAll(
                ".rcr-checkbox"
            )
        ) {
            checkbox.checked = true;
        }
    }

    function clearAll() {
        for (
            const checkbox of
            document.querySelectorAll(
                ".rcr-checkbox"
            )
        ) {
            checkbox.checked = false;
        }
    }

    function createUI() {
        const root =
            document.createElement("div");

        root.id =
            "reddit-comment-redactor";

        root.innerHTML = `
            <div class="rcr-header">
                <strong>
                    Reddit Comment Redactor
                </strong>

                <button id="rcr-close">
                    ×
                </button>
            </div>

            <div class="rcr-info">
                <div>
                    Replacement:
                    <code>${escapeHtml(
                        CONFIG.replacement
                    )}</code>
                </div>

                <div>
                    Dry-run only until you explicitly
                    click "Redact selected".
                </div>
            </div>

            <div class="rcr-controls">
                <button id="rcr-scan">
                    Scan comments
                </button>

                <button
                    id="rcr-redact"
                    disabled
                >
                    Redact selected
                </button>

                <button
                    id="rcr-select"
                    disabled
                >
                    Select all
                </button>

                <button
                    id="rcr-clear"
                    disabled
                >
                    Clear selection
                </button>
            </div>

            <div class="rcr-options">
                <label>
                    Batch:
                    <input
                        id="rcr-batch"
                        type="number"
                        min="1"
                        max="50"
                        value="${CONFIG.batchSize}"
                    >
                </label>

                <label>
                    Delay:
                    <input
                        id="rcr-delay"
                        type="number"
                        min="500"
                        max="30000"
                        value="${CONFIG.delayMs}"
                    >
                    ms
                </label>
            </div>

            <div id="rcr-status">
                Ready.
            </div>

            <div id="rcr-list"></div>
        `;

        document.body.appendChild(root);

        document.querySelector(
            "#rcr-close"
        ).addEventListener(
            "click",
            () => root.remove()
        );

        document.querySelector(
            "#rcr-scan"
        ).addEventListener(
            "click",
            scan
        );

        document.querySelector(
            "#rcr-redact"
        ).addEventListener(
            "click",
            redactSelected
        );

        document.querySelector(
            "#rcr-select"
        ).addEventListener(
            "click",
            selectAll
        );

        document.querySelector(
            "#rcr-clear"
        ).addEventListener(
            "click",
            clearAll
        );
    }

    GM_addStyle(`
        #reddit-comment-redactor {
            position: fixed;
            z-index: 2147483647;

            top: 20px;
            right: 20px;

            width: min(
                950px,
                calc(100vw - 40px)
            );

            max-height:
                calc(100vh - 40px);

            display: flex;
            flex-direction: column;

            background: #111;
            color: #eee;

            border:
                1px solid #555;

            font-family:
                system-ui,
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                sans-serif;

            font-size: 14px;

            box-shadow:
                0 10px 40px
                rgba(0, 0, 0, 0.6);
        }

        #reddit-comment-redactor button {
            background: #222;
            color: #eee;

            border:
                1px solid #555;

            padding:
                8px 12px;

            cursor: pointer;
        }

        #reddit-comment-redactor
        button:hover:not(:disabled) {
            background: #333;
        }

        #reddit-comment-redactor
        button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .rcr-header {
            display: flex;
            align-items: center;
            justify-content: space-between;

            padding: 10px 12px;

            background: #181818;

            border-bottom:
                1px solid #444;
        }

        #rcr-close {
            border: 0 !important;
            padding: 2px 8px !important;

            font-size: 20px;
        }

        .rcr-info {
            padding: 10px;

            background: #202020;

            border-bottom:
                1px solid #333;

            line-height: 1.6;
        }

        .rcr-info code {
            color: #fff;
        }

        .rcr-controls {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;

            padding: 10px;
        }

        .rcr-options {
            display: flex;
            gap: 20px;

            padding:
                0 10px 10px;
        }

        .rcr-options input {
            width: 70px;

            padding: 5px;

            background: #111;
            color: #eee;

            border:
                1px solid #555;
        }

        #rcr-status {
            padding: 10px;

            background: #181818;

            border-top:
                1px solid #333;

            border-bottom:
                1px solid #333;
        }

        #rcr-list {
            overflow-y: auto;
            min-height: 100px;
        }

        .rcr-item {
            display: flex;
            gap: 10px;

            padding: 10px;

            border-bottom:
                1px solid #333;
        }

        .rcr-item:hover {
            background: #181818;
        }

        .rcr-checkbox {
            flex: 0 0 auto;
            margin-top: 4px;
        }

        .rcr-content {
            min-width: 0;
            flex: 1;
        }

        .rcr-meta {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;

            margin-bottom: 6px;

            color: #aaa;
        }

        .rcr-meta strong {
            color: #e88;
        }

        .rcr-body {
            margin-bottom: 6px;

            color: #ccc;

            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .rcr-content a {
            color: #6cb6ff;
        }

        .rcr-empty {
            padding: 30px;

            text-align: center;

            color: #aaa;
        }
    `);

    createUI();
})();
