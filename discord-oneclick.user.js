// ==UserScript==
// @name         Discord Attachment Auto-Renamer with History & Cleansing
// @namespace    https://local.discord.tools/
// @version      4.2.0
// @description  Web版Discord添付ファイル階層保存。先頭画像フロートボタン、CP932(Shift_JIS)完全準拠クレンジング(外字ハート/かな救出/波ダッシュ/丸数字/禁則文字全角化)、重複防止、履歴DB機能。
// @author       You
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

/* global BigInt */

(function () {
    'use strict';

    const BASE_FOLDER = 'Discord';
    const STORAGE_KEY = 'discord_download_history_v1';
    const CONFIG_CLEANSING_KEY = 'config_enable_cleansing';
    const CONFIG_FORMAT_KEY = 'config_filename_format'; // 1: Prefix, 2: Suffix, 3: Original only

    /**
     * Windows-31J (CP932 / Shift_JIS) 完全準拠の文字セットを構築（初回のみ遅延生成）
     * name2win.exe の Encoding.GetEncoding(932) と 100% 同一の判定を実現
     */
    let cp932ValidSet = null;
    function getCp932ValidSet() {
        if (cp932ValidSet) return cp932ValidSet;
        const set = new Set();

        // 1. ASCII印字可能文字 (0x20 - 0x7E)
        for (let c = 0x20; c <= 0x7E; c++) {
            set.add(String.fromCharCode(c));
        }
        // 2. 半角カタカナ (0xA1 - 0xDF -> U+FF61 - U+FF9F)
        for (let c = 0xFF61; c <= 0xFF9F; c++) {
            set.add(String.fromCharCode(c));
        }
        // 3. CP932 外字領域 (0xF040 - 0xF9FC -> U+E000 - U+E757 全1,880文字)
        for (let c = 0xE000; c <= 0xE757; c++) {
            set.add(String.fromCharCode(c));
        }
        // 4. 2バイト Shift_JIS 領域 (JIS第1・第2水準、NEC特殊文字、IBM拡張漢字)
        try {
            const decoder = new TextDecoder('shift-jis', { fatal: true });
            const buf = new Uint8Array(2);
            const leads = [
                [0x81, 0x9F],
                [0xE0, 0xEF],
                [0xFA, 0xFC]
            ];
            for (const [lStart, lEnd] of leads) {
                for (let lead = lStart; lead <= lEnd; lead++) {
                    buf[0] = lead;
                    for (let trail = 0x40; trail <= 0xFC; trail++) {
                        if (trail === 0x7F) continue;
                        buf[1] = trail;
                        try {
                            const ch = decoder.decode(buf);
                            if (ch.length === 1) set.add(ch);
                        } catch (_) {
                            // 未定義の2バイト組み合わせはスキップ
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Discord OneClick] TextDecoder shift-jis initialization warning:', e);
        }

        // 5. WHATWG shift-jis と Microsoft CP932 のマッピング差異7文字を Windows CP932 側に完全一致させる
        // CP932で有効な文字を追加
        ['\u2015', '\uFF5E', '\u2225', '\uFF0D', '\uFFE0', '\uFFE1', '\uFFE2'].forEach(ch => set.add(ch));
        // CP932では 0x3F (?) になる非対応文字を除外
        ['\u301C', '\u2016', '\u2212', '\u00A2', '\u00A3', '\u00AC'].forEach(ch => set.delete(ch));

        cp932ValidSet = set;
        return cp932ValidSet;
    }

    // 古いWin32アプリ互換ファイル名化機能の有効/無効判定（デフォルト: true）
    function isCleansingEnabled() {
        return GM_getValue(CONFIG_CLEANSING_KEY, true);
    }

    // ファイル名書式の取得（デフォルト: 1）
    function getFilenameFormat() {
        return GM_getValue(CONFIG_FORMAT_KEY, 1);
    }

    /**
     * 文字列サニタイズ処理（古いWin32アプリ互換ファイル名化 - CP932完全準拠）
     */
    function sanitizeName(name) {
        if (!name) return '';

        // Step 1: macOS濁点結合 & 西欧ダイアクリティカルマーク除去・特殊ラテン文字展開 (pokémon -> pokemon, ß -> ss, æ -> ae, ø -> o 等)
        // ※ NFDで分解されない西欧合字・ストローク付き文字を展開後、NFD分解 -> U+0300〜U+036Fのみ消去 -> NFC結合 (日本語の濁点・半濁点は完全保護)
        let s = name
            .replace(/\u00DF/g, 'ss')
            .replace(/\u1E9E/g, 'SS')
            .replace(/\u00C6/g, 'AE')
            .replace(/\u00E6/g, 'ae')
            .replace(/\u0152/g, 'OE')
            .replace(/\u0153/g, 'oe')
            .replace(/\u00D8/g, 'O')
            .replace(/\u00F8/g, 'o')
            .replace(/\u0141/g, 'L')
            .replace(/\u0142/g, 'l')
            .replace(/[\u0110\u00D0]/g, 'D')
            .replace(/[\u0111\u00F0]/g, 'd')
            .replace(/\u00DE/g, 'TH')
            .replace(/\u00FE/g, 'th')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .normalize('NFC');

        // Step 1.5: macOS / PDF由来の康熙部首 (U+2F00-U+2FD5) ・ CJK部首補助 (U+2E80-U+2EFF) を標準JIS漢字へ正規化救出 (⼀ -> 一 等)
        s = s.replace(/[\u2E80-\u2FD5]/g, ch => ch.normalize('NFKC'));

        // Step 2: 波ダッシュ・JIS/CP932マッピング不一致記号の是正
        s = s
            .replace(/[\u301C\u3030]/g, '\uFF5E') // 〜 (WAVE DASH), 〰 (WAVY DASH) -> ～ (全角チルダ 0x8160)
            .replace(/\u2016/g, '\u2225')         // ‖ -> ∥ (双柱 0x8161)
            .replace(/\u00A2/g, '\uFFE0')         // ¢ -> ￠ (セント 0x8191)
            .replace(/\u00A3/g, '\uFFE1')         // £ -> ￡ (ポンド 0x8192)
            .replace(/\u00AC/g, '\uFFE2');        // ¬ -> ￢ (ノット 0x81CA)

        // Step 3: 丸数字の置換・展開
        s = s.replace(/[\u2776-\u277F]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x2776 + 0x2460)); // ❶-❿ -> ①-⑩
        s = s.replace(/[\u2780-\u2789]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x2780 + 0x246A)); // ⓫-⓴ -> ⑪-⑳
        s = s.replace(/[\u3251-\u325F]/g, ch => `(${ch.charCodeAt(0) - 0x3251 + 21})`); // ㉑-㉟ -> (21)-(35)
        s = s.replace(/[\u32B1-\u32BF]/g, ch => `(${ch.charCodeAt(0) - 0x32B1 + 36})`); // ㊱-㊿ -> (36)-(50)

        // クレンジングが有効な場合のみ「Win32 / MangaMeeya (CP932) 完全互換処理」を実行
        if (isCleansingEnabled()) {
            // Step 4: macOS地雷文字・全半角ダッシュ・ハイフン類の完全標準化
            s = s
                .replace(/[\u2010\u2014\u2015\u2212\uFE58\uFE63\u2E3A\u2E3B\u30A0]/g, '\uFF0D') // 全角系ダッシュ・ハイフン・マイナス類(9種) -> Windows全角ハイフンマイナス '－' (0x817C)
                .replace(/[\u2011\u2012\u2013\u2043]/g, '-')        // 半角・欧文系ハイフン・ENダッシュ類(4種) -> 半角ハイフン '-' (0x2D)
                .replace(/[\u00A0\u2002\u2003\u2009\u202F]/g, ' ') // 特殊スペース -> 半角空白
                .replace(/[\u00AD\u200B\u200C\u200D\uFEFF\uFE0E\uFE0F]/g, '') // 不可視ゴミ（ソフトハイフン・異体字セレクタ含む） -> 削除
                .replace(/[\u2018\u2019\u201A\u201B]/g, "'");     // カーリークォート -> '

            // Step 5: かな・記号ファミリー集約（MangaMeeya・古のWin32救出：変換先はすべて純粋なCP932文字のみ）
            s = s
                // CP932非対応のひらがな・カタカナ（ゔ, ゕ, ゖ, ヷ, ヸ, ヹ, ヺ）をCP932対応カナへ救出
                .replace(/\u3094/g, 'ヴ')
                .replace(/\u3095/g, 'ヵ')
                .replace(/\u3096/g, 'ヶ')
                .replace(/\u30F7/g, 'ヴァ')
                .replace(/\u30F8/g, 'ヴィ')
                .replace(/\u30F9/g, 'ヴェ')
                .replace(/\u30FA/g, 'ヴォ')
                // ハート系絵文字 および Unicode黒ハート(♥) -> Shift_JIS外字黒ハート「\uE0A5」(0xF0E6)へ集約
                .replace(/\u2665|\u2764\uFE0F?|[\uD83D][\uDC93-\uDC9F]|[\uD83E][\uDD70\uDE0D-\uDE0F\uDFE1]|[\uD83E][\uDE75-\uDE77]/g, '\uE0A5')
                // Unicode白ハート(♡) -> Shift_JIS外字白ハート「\uE006」(0xF046)へ変換
                .replace(/\u2661/g, '\uE006')
                // 三角系絵文字・右左小三角 -> 「▲」「△」「▼」「▽」 (CP932: 0x81A3, 0x81A2, 0x81A5, 0x81A4)
                .replace(/[\uD83D]\uDD3A|[\u25B4\u25B6\u25B8\u25BA]/g, '▲')
                .replace(/[\u25B5\u25B7\u25B9\u25BB]/g, '△')
                .replace(/[\uD83D]\uDD3B|[\u25BE\u25C0\u25C2\u25C4]/g, '▼')
                .replace(/[\u25BF\u25C1\u25C3\u25C5]/g, '▽')
                // ダイヤ系絵文字 -> 「◆」「◇」 (CP932: 0x819F, 0x819E)
                .replace(/[\uD83D][\uDD36\uDD37]/g, '◆')
                .replace(/[\uD83D][\uDD38\uDD39]/g, '◇')
                // 丸系絵文字 -> 「●」「○」 (CP932: 0x819C, 0x819B)
                .replace(/\u26AB|[\uD83D][\uDD34\uDD35]|[\uD83E][\uDFE0-\uDFE4]/g, '●')
                .replace(/\u26AA/g, '○')
                // 星・キラキラ系 -> 「★」 (CP932: 0x819A)
                .replace(/\u2B50|\u2728|[\uD83C][\uDF1F\uDF20]|[\uD83D][\uDCAB]|\u2606/g, '★')
                // 音符系 (🎵🎶🎼♩♫♬) -> 「♪」 (CP932: 0x81F4)
                .replace(/[\uD83C][\uDFB5\uDFB6\uDFBC]|[\u2669\u266B\u266C]/g, '♪');

            // Step 6: サロゲートペア絵文字（2文字組）を単一の「■」へ集約
            s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '■');

            // Step 7: CP932 (Windows-31J) 全文字セットによる100%厳密検証
            // （簡体字・繁体字・ハングル・非対応BMP記号など、CP932外のあらゆる文字を漏れなく単一「■」へ変換）
            const validSet = getCp932ValidSet();
            let out = '';
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (c.charCodeAt(0) < 32) continue;
                out += validSet.has(c) ? c : '■';
            }
            s = out;
        }

        // Step 8: Windowsファイル名禁止文字・パス区切りの安全な全角化
        s = s
            .replace(/\//g, '／')
            .replace(/\\/g, '＼')
            .replace(/:/g, '：')
            .replace(/\*/g, '＊')
            .replace(/\?/g, '？')
            .replace(/"/g, '”')
            .replace(/</g, '＜')
            .replace(/>/g, '＞')
            .replace(/\|/g, '｜')
            .replace(/[\r\n\t]/g, '');

        // 末尾のスペースとピリオドを削除（Windows仕様）
        return s.trim().replace(/[. ]+$/, '');
    }

    /**
     * 日時フォーマット (ファイル名用: YYYY-MM-DDTHHMMSS)
     */
    function formatFileTimestamp(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    /**
     * 日時フォーマット (ログ用: YYYY-MM-DD HH:mm:ss)
     */
    function formatLogTimestamp(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function extractAttachmentId(url) {
        const match = (url || '').match(/\/attachments\/\d+\/(\d+)\//);
        return match ? match[1] : null;
    }

    function extractThreadId(url) {
        const match = (url || '').match(/\/attachments\/(\d+)\//);
        if (match && match[1]) return match[1];

        const urlMatch = location.href.match(/\/threads\/(\d+)/);
        if (urlMatch && urlMatch[1]) return urlMatch[1];

        return '';
    }

    // --- データベース（ストレージ）操作 ---

    function getAllLogs() {
        return GM_getValue(STORAGE_KEY, {});
    }

    function getDownloadRecord(attachmentId) {
        if (!attachmentId) return null;
        const logs = getAllLogs();
        return logs[attachmentId] || null;
    }

    function saveOrUpdateRecord(data) {
        const logs = getAllLogs();
        const nowStr = formatLogTimestamp(new Date());

        if (logs[data.id]) {
            logs[data.id].lastDownloadedAt = nowStr;
            logs[data.id].downloadCount = (logs[data.id].downloadCount || 1) + 1;
            logs[data.id].savedPath = data.savedPath;
        } else {
            logs[data.id] = {
                id: data.id,
                server: data.server,
                channel: data.channel,
                thread: data.thread,
                threadId: data.threadId || '',
                originalName: data.originalName,
                savedPath: data.savedPath,
                postDate: data.postDate,
                firstDownloadedAt: nowStr,
                lastDownloadedAt: nowStr,
                downloadCount: 1,
                url: data.url
            };
        }
        GM_setValue(STORAGE_KEY, logs);
    }

    // --- DOM解析関数群 ---

    function getCurrentServerName() {
        const serverHeader = document.querySelector('header h2[class*="name_"], [class*="sidebar_"] header h2, h2[class*="name_"]');
        if (serverHeader && serverHeader.textContent.trim()) {
            return sanitizeName(serverHeader.textContent.trim());
        }
        const titleParts = document.title.split('|').map(s => s.trim());
        if (titleParts.length >= 2) {
            const last = titleParts[titleParts.length - 1];
            if (last && !last.includes('Discord')) return sanitizeName(last);
        }
        return 'DirectMessages';
    }

    function getCurrentChannelName() {
        const activeChannel = document.querySelector('[class*="selected_"] [data-text-variant="text-md/medium"], [class*="selected_"] [class*="name_"]');
        if (activeChannel && activeChannel.textContent.trim()) {
            return sanitizeName(activeChannel.textContent.trim());
        }
        const headerTitle = document.querySelector('section[class*="title_"] [class*="title_"], section[class*="title_"] [data-text-variant="text-md/medium"]');
        if (headerTitle && headerTitle.textContent.trim()) {
            return sanitizeName(headerTitle.textContent.trim().replace(/^#\s*/, ''));
        }
        return 'General';
    }

    function getCurrentThreadName() {
        const threadHeaderSection = document.querySelector('section[aria-label="スレッドのヘッダー"], section[aria-label*="スレッド"], section[aria-label*="Thread"]');
        if (threadHeaderSection) {
            const h2 = threadHeaderSection.querySelector('h2');
            if (h2) {
                const clone = h2.cloneNode(true);
                clone.querySelectorAll('span[class*="hiddenVisually"]').forEach(s => s.remove());
                const text = clone.textContent.trim();
                if (text) return sanitizeName(text);
            }
        }
        const titleWrapperH2 = document.querySelector('div[class*="titleWrapper"] h2');
        if (titleWrapperH2) {
            const clone = titleWrapperH2.cloneNode(true);
            clone.querySelectorAll('span[class*="hiddenVisually"]').forEach(s => s.remove());
            const text = clone.textContent.trim();
            if (text) return sanitizeName(text);
        }
        return '';
    }

    function extractMessageDate(element) {
        const container = element.closest('[role="article"], li[id*="chat-messages-"], [class*="messageListItem_"]');
        if (container) {
            const timeTag = container.querySelector('time[datetime]');
            if (timeTag) {
                const dt = new Date(timeTag.getAttribute('datetime'));
                if (!isNaN(dt.getTime())) return dt;
            }
        }
        let prev = container ? container.previousElementSibling : element.parentElement;
        while (prev && prev !== document.body) {
            const timeTag = prev.querySelector('time[datetime]');
            if (timeTag) {
                const dt = new Date(timeTag.getAttribute('datetime'));
                if (!isNaN(dt.getTime())) return dt;
            }
            prev = prev.previousElementSibling || prev.parentElement;
        }
        try {
            const match = (element.href || '').match(/\/attachments\/\d+\/(\d+)\//);
            if (match && match[1]) {
                const idBigInt = BigInt(match[1]);
                return new Date(Number((idBigInt >> 22n) + 1420070400000n));
            }
        } catch (e) { }
        return new Date();
    }

    function getCleanFileName(linkElement) {
        let name = (linkElement.textContent || '').trim();

        // テキストが空の場合（ダウンロードアイコン等の <a> タグ）、同じ添付ファイル枠内の fileNameLink を探す
        if (!name || name.length > 200 || !name.includes('.')) {
            const container = linkElement.closest('[class*="attachment_"], [class*="messageListItem_"], [role="article"]');
            if (container) {
                const nameNode = container.querySelector('[class*="fileNameLink"]');
                if (nameNode && nameNode.textContent) {
                    name = nameNode.textContent.trim();
                }
            }
        }

        // それでも無効なら aria-label などの属性を試す
        if (!name || name.length > 200 || !name.includes('.')) {
            name = (linkElement.getAttribute('aria-label') || linkElement.title || '').trim();
        }

        // 最終手段としてURLから推測（Discord側の省略ファイル名になる可能性あり）
        if (!name || name.length > 200 || !name.includes('.')) {
            try {
                const url = new URL(linkElement.href);
                name = decodeURIComponent(url.pathname.substring(url.pathname.lastIndexOf('/') + 1));
            } catch (e) {
                name = 'download.zip';
            }
        }
        return sanitizeName(name);
    }

    function buildRelativeSavePath(linkElement) {
        const serverName = getCurrentServerName();
        const channelName = getCurrentChannelName();
        const rawThreadName = getCurrentThreadName();
        const threadId = extractThreadId(linkElement.href);

        let finalThreadFolder = '';
        if (rawThreadName) {
            finalThreadFolder = threadId ? `${threadId}_${rawThreadName}` : rawThreadName;
        }

        const postDate = extractMessageDate(linkElement);
        const dateStr = formatFileTimestamp(postDate);
        const baseName = getCleanFileName(linkElement);
        const formatOption = getFilenameFormat();
        
        let fileName = '';
        if (formatOption === 3) {
            // オプション3: 日付なし（元のファイル名のみ）
            fileName = baseName;
        } else if (formatOption === 2) {
            // オプション2: ファイル名_タイムスタンプ.* の形式
            const lastDot = baseName.lastIndexOf('.');
            if (lastDot !== -1 && lastDot > 0) {
                const namePart = baseName.substring(0, lastDot);
                const extPart = baseName.substring(lastDot);
                fileName = `${namePart}_${dateStr}${extPart}`;
            } else {
                fileName = `${baseName}_${dateStr}`;
            }
        } else {
            // オプション1（デフォルト）: タイムスタンプ_ファイル名.* の形式
            fileName = `${dateStr}_${baseName}`;
        }

        const pathParts = [];
        if (BASE_FOLDER) pathParts.push(BASE_FOLDER);
        if (serverName) pathParts.push(serverName);
        if (channelName) pathParts.push(channelName);
        if (finalThreadFolder) pathParts.push(finalThreadFolder);
        pathParts.push(fileName);

        return {
            relativePath: pathParts.join('/'),
            serverName,
            channelName,
            threadName: finalThreadFolder,
            threadId,
            postDateStr: dateStr,
            fileName
        };
    }

    // --- ダウンロード・重複判定ロジック ---

    function handleDownloadRequest(linkElement, buttonElement = null) {
        const url = linkElement.href;
        const attId = extractAttachmentId(url);
        const record = getDownloadRecord(attId);
        const originalName = getCleanFileName(linkElement);

        if (record) {
            const confirmMsg =
                `【重複ダウンロードの確認】\n\n` +
                `このファイルは既にダウンロード済みです。\n\n` +
                `・ファイル名: ${originalName}\n` +
                `・前回DL日時: ${record.lastDownloadedAt}\n` +
                `・過去のDL回数: ${record.downloadCount} 回\n\n` +
                `強制的に再ダウンロードしますか？`;

            if (!window.confirm(confirmMsg)) {
                return;
            }
        }

        const pathInfo = buildRelativeSavePath(linkElement);
        const setStatus = (text) => {
            if (buttonElement) buttonElement.textContent = text;
        };

        setStatus('⏳ DL中...');

        GM_download({
            url: url,
            name: pathInfo.relativePath,
            saveAs: false,
            onload: () => {
                saveOrUpdateRecord({
                    id: attId,
                    server: pathInfo.serverName,
                    channel: pathInfo.channelName,
                    thread: pathInfo.threadName,
                    threadId: pathInfo.threadId,
                    originalName: originalName,
                    savedPath: pathInfo.relativePath,
                    postDate: pathInfo.postDateStr,
                    url: url
                });

                if (buttonElement) {
                    applyDownloadedStyle(buttonElement);
                }
            },
            onerror: (err) => {
                console.error('[Auto-Renamer] GM_download エラー:', err);
                setStatus('❌ エラー');
                showDownloadErrorHint(err);
                const flatName = pathInfo.relativePath.replace(/\//g, '_');
                GM_download({
                    url: url,
                    name: flatName,
                    saveAs: false
                });
            }
        });
    }

    // ダウンロード失敗時の原因別ヒント表示（同一セッションで1回のみ）
    let downloadErrorHintShown = false;
    function showDownloadErrorHint(err) {
        if (downloadErrorHintShown) return;
        downloadErrorHintShown = true;

        const code = (err && err.error) ? err.error : 'unknown';
        let hint;
        switch (code) {
            case 'not_permitted':
                hint = 'ダウンロード権限が許可されていません。\n' +
                       'Tampermonkey 5.5 以降では、初回保存時に表示されるダウンロード権限の要求を「許可」する必要があります。';
                break;
            case 'not_enabled':
            case 'not_whitelisted':
                hint = 'Tampermonkey のダウンロード設定によりブロックされました。\n' +
                       '設定 → ダウンロード BETA の「Download Mode」が「Browser API」になっているか、\n' +
                       'ファイル拡張子のホワイトリストを確認してください。';
                break;
            case 'not_supported':
                hint = '現在の Download Mode ではフォルダ付き保存がサポートされていません。\n' +
                       'Download Mode を「Native」から「Browser API」に変更してください。';
                break;
            default:
                hint = 'ネットワークエラー、またはブラウザ側でダウンロードが拒否された可能性があります。';
        }

        alert(`[discord-oneclick] 階層フォルダでの保存に失敗しました（${code}）。\n\n` +
              `${hint}\n\n` +
              `※ フォルダ区切りを「_」に置き換えたファイル名で保存を再試行します。\n` +
              `詳細は README の「初回設定」を参照してください。`);
    }

    function applyDownloadedStyle(btn) {
        btn.textContent = '✔ 済';
        btn.title = 'ダウンロード済みです（クリックで強制再ダウンロード）';
        btn.style.backgroundColor = '#4e5058';
        btn.style.color = '#dbdee1';
        btn.onmouseenter = () => { btn.style.backgroundColor = '#6d6f78'; };
        btn.onmouseleave = () => { btn.style.backgroundColor = '#4e5058'; };
    }

    // --- クリックのインターセプト（ZIP等の通常ファイルリンク） ---

    document.addEventListener('click', function (event) {
        // 画像ではなく、ZIPや添付ファイル名リンクが直接クリックされた場合のみ横取り保存
        const link = event.target.closest('a[class*="fileNameLink"]');
        if (!link) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const customBtn = link.parentElement ? link.parentElement.querySelector('.discord-rename-btn') : null;
        handleDownloadRequest(link, customBtn);
    }, true);

    // --- ボタンの自動生成（先頭画像フロート対応） ---

    // Reactの再描画（Hydration）によってインラインの style="position: relative" が
    // 吹き飛ばされてしまうのを防ぐため、専用のCSSクラスを定義しておく
    if (!document.getElementById('discord-rename-styles')) {
        const style = document.createElement('style');
        style.id = 'discord-rename-styles';
        style.textContent = `
            .discord-rename-target {
                position: relative !important;
            }
        `;
        document.head.appendChild(style);
    }

    function injectButtons() {
        const links = document.querySelectorAll('a[href*="cdn.discordapp.com/attachments/"], a[href*="media.discordapp.net/attachments/"]');

        links.forEach(link => {
            const isImageWrapper = Boolean(link.closest('.imageWrapper') || link.closest('.visualMediaItemContainer_f4758a') || link.getAttribute('data-role') === 'img');
            
            // 挿入先ラッパーの決定
            let targetWrapper = link.parentElement;
            if (isImageWrapper) {
                // 部分一致の罠（mosaicItemContent 等の中身コンテナ）を回避し、本当の外枠（hideOverflowを持つ mosaicItem 等）を確実につかむ
                targetWrapper = link.closest('[class*="mosaicItem"]:not([class*="Content"])') || 
                                link.closest('[class*="messageAttachment"]:not([class*="Content"])') || 
                                link.closest('[class*="attachment_"]:not([class*="Content"])') || 
                                link.closest('.imageWrapper') || 
                                link.parentElement;
            }

            // Reactの再描画でクラスが消された場合は、何度でも付け直す（見切れ防止の要）
            if (isImageWrapper && targetWrapper && !targetWrapper.classList.contains('discord-rename-target')) {
                targetWrapper.classList.add('discord-rename-target');
            }

            if (link.getAttribute('data-rename-ready') === 'true') return;
            if (targetWrapper && targetWrapper.querySelector(':scope > .discord-rename-btn')) {
                link.setAttribute('data-rename-ready', 'true');
                return;
            }

            link.setAttribute('data-rename-ready', 'true');

            const attId = extractAttachmentId(link.href);
            const isDownloaded = Boolean(getDownloadRecord(attId));

            const btn = document.createElement('button');
            btn.className = 'discord-rename-btn';
            btn.textContent = isDownloaded ? '✔ 済' : '📥 フォルダ保存';
            btn.title = isDownloaded
                ? 'ダウンロード済みです（クリックで強制再ダウンロード）'
                : 'サーバー/チャンネル/スレッドの階層フォルダに日時付きで自動保存します';

            // スタイリングの分岐（画像用フロート表示 vs 通常リンク横表示）
            if (isImageWrapper) {
                btn.style.cssText = `
                    position: absolute;
                    top: 8px;
                    left: 8px;
                    z-index: 10000;
                    padding: 3px 8px;
                    font-size: 11px;
                    font-weight: bold;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.5);
                    backdrop-filter: blur(2px);
                    transition: background 0.15s, transform 0.1s;
                `;
            } else {
                btn.style.cssText = `
                    margin-left: 8px;
                    padding: 1px 6px;
                    font-size: 11px;
                    font-weight: bold;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    vertical-align: middle;
                    z-index: 999;
                    transition: background 0.15s;
                `;
            }

            if (isDownloaded) {
                applyDownloadedStyle(btn);
            } else {
                btn.style.backgroundColor = isImageWrapper ? 'rgba(35, 165, 90, 0.92)' : '#23a55a';
                btn.style.color = '#ffffff';
                btn.onmouseenter = () => { btn.style.backgroundColor = '#1a8347'; };
                btn.onmouseleave = () => { btn.style.backgroundColor = isImageWrapper ? 'rgba(35, 165, 90, 0.92)' : '#23a55a'; };
            }

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                handleDownloadRequest(link, btn);
            }, true);

            // DOM挿入位置の決定（画像ならクロップ枠の先頭へ、通常ならリンク直後へ）
            if (isImageWrapper && targetWrapper) {
                targetWrapper.appendChild(btn);
            } else {
                link.insertAdjacentElement('afterend', btn);
            }
        });
    }

    const observer = new MutationObserver(() => injectButtons());
    observer.observe(document.body, { childList: true, subtree: true });

    // --- エクスポート＆設定メニュー（Tampermonkey） ---

    function downloadFile(content, fileName, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // 0. クレンジング機能のON/OFF切り替えメニュー
    const currentCleansing = isCleansingEnabled();
    const toggleLabel = currentCleansing ? '【有効】 (クリックで無効化)' : '【無効】 (クリックで有効化)';
    GM_registerMenuCommand(`⚙️ 古いWin32互換ファイル名化: ${toggleLabel}`, () => {
        const nextState = !currentCleansing;
        GM_setValue(CONFIG_CLEANSING_KEY, nextState);
        alert(`Win32互換ファイル名化（クレンジング）機能を ${nextState ? '【有効】' : '【無効】'} に切り替えました。\nページをリロードして反映します。`);
        location.reload();
    });

    // ファイル名書式の切り替えメニュー（ラジオボタン風）
    const currentFormat = getFilenameFormat();
    const formats = [
        { id: 1, label: '日付_ファイル名.*' },
        { id: 2, label: 'ファイル名_日付.*' },
        { id: 3, label: 'ファイル名のみ (日付なし)' }
    ];

    formats.forEach(f => {
        const isCurrent = (currentFormat === f.id);
        const icon = isCurrent ? '🔘' : '⚪';
        GM_registerMenuCommand(`${icon} 書式: ${f.label}`, () => {
            if (isCurrent) return; // 既に選択中の場合は何もしない
            GM_setValue(CONFIG_FORMAT_KEY, f.id);
            alert(`ファイル名書式を「${f.label}」に変更しました。\nページをリロードして反映します。`);
            location.reload();
        });
    });

    // 1. 現在チャンネルのログを CSV 出力
    GM_registerMenuCommand('📊 [現在チャンネル] のログをCSV出力', () => {
        const logs = getAllLogs();
        const currentChannel = getCurrentChannelName();
        const records = Object.values(logs).filter(r => r.channel === currentChannel);

        if (records.length === 0) {
            alert(`「${currentChannel}」チャンネルのダウンロード履歴はまだありません。`);
            return;
        }

        const headers = ['ID', 'サーバー', 'チャンネル', 'スレッド', 'ファイル名', '保存先パス', '投稿日時', '初回DL日時', '最終DL日時', 'DL回数', 'URL'];
        const csvRows = [headers.join(',')];

        records.forEach(r => {
            const row = [
                `"${r.id}"`,
                `"${r.server || ''}"`,
                `"${r.channel || ''}"`,
                `"${r.thread || ''}"`,
                `"${r.originalName || ''}"`,
                `"${r.savedPath || ''}"`,
                `"${r.postDate || ''}"`,
                `"${r.firstDownloadedAt || ''}"`,
                `"${r.lastDownloadedAt || ''}"`,
                r.downloadCount || 1,
                `"${r.url || ''}"`
            ];
            csvRows.push(row.join(','));
        });

        const bom = '\uFEFF';
        downloadFile(bom + csvRows.join('\r\n'), `Discord_Log_${currentChannel}.csv`, 'text/csv;charset=utf-8');
    });

    // 2. 全ログを SQLite用 SQLファイルとして出力
    GM_registerMenuCommand('🗄️ [全チャンネル] SQLite用SQLを出力', () => {
        const logs = getAllLogs();
        const records = Object.values(logs);

        if (records.length === 0) {
            alert('ダウンロード履歴がまだありません。');
            return;
        }

        let sql = `-- Discord Download History SQLite Dump\n`;
        sql += `CREATE TABLE IF NOT EXISTS downloads (\n`;
        sql += `    id TEXT PRIMARY KEY,\n`;
        sql += `    server TEXT,\n`;
        sql += `    channel TEXT,\n`;
        sql += `    thread TEXT,\n`;
        sql += `    original_name TEXT,\n`;
        sql += `    saved_path TEXT,\n`;
        sql += `    post_date TEXT,\n`;
        sql += `    first_downloaded_at TEXT,\n`;
        sql += `    last_downloaded_at TEXT,\n`;
        sql += `    download_count INTEGER,\n`;
        sql += `    url TEXT\n`;
        sql += `);\n\n`;

        records.forEach(r => {
            const escapeSql = (s) => (s ? String(s).replace(/'/g, "''") : '');
            sql += `INSERT OR REPLACE INTO downloads VALUES (` +
                `'${escapeSql(r.id)}', ` +
                `'${escapeSql(r.server)}', ` +
                `'${escapeSql(r.channel)}', ` +
                `'${escapeSql(r.thread)}', ` +
                `'${escapeSql(r.originalName)}', ` +
                `'${escapeSql(r.savedPath)}', ` +
                `'${escapeSql(r.postDate)}', ` +
                `'${escapeSql(r.firstDownloadedAt)}', ` +
                `'${escapeSql(r.lastDownloadedAt)}', ` +
                `${r.downloadCount || 1}, ` +
                `'${escapeSql(r.url)}');\n`;
        });

        downloadFile(sql, `discord_downloads_${formatFileTimestamp(new Date())}.sql`, 'text/plain;charset=utf-8');
    });

    // 3. 全ログを JSON バックアップ出力
    GM_registerMenuCommand('📦 [全ログ] JSONバックアップ出力', () => {
        const logs = getAllLogs();
        downloadFile(JSON.stringify(logs, null, 2), `discord_logs_backup_${formatFileTimestamp(new Date())}.json`, 'application/json');
    });

})();