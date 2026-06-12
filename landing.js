/* ============================================================
   Oh — landing page interactions
   - nav scroll state
   - scroll reveal (IntersectionObserver)
   - animated hero terminal (typed ask + cited answer)
   - tabbed cross-tool demo (Claude Code / Codex)
   - copy button
   ============================================================ */
(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- nav scroll state ---------- */
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- scroll reveal + in-view triggers (rect-based) ----------
     IntersectionObserver is unreliable in some embedded preview frames,
     so we use a getBoundingClientRect scan on scroll/resize/load. */
  const reveals = document.querySelectorAll(".reveal");

  function inView(el, margin) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh - (margin || 0) && r.bottom > 0;
  }

  function scanReveals() {
    if (reduceMotion) {
      reveals.forEach((el) => el.classList.add("in"));
    } else {
      reveals.forEach((el) => {
        if (!el.classList.contains("in") && inView(el, 60)) el.classList.add("in");
      });
    }
    if (!heroPlayed && (reduceMotion || inView(document.getElementById("heroTerm"), 100))) playHero();
    if (!crossPlayed && (reduceMotion || inView(document.getElementById("crossTerm"), 100))) playCrossOnce();
    if (!insPlayed && (reduceMotion || inView(document.getElementById("insTerm"), 100))) playInsOnce();
  }

  /* ============================================================
     Terminal renderer — plays a script of lines with typing.
     A "script" is an array of steps:
       { t:"prompt", text }                  -> typed `$ ...` line
       { t:"line",   html, cls, delay }      -> printed instantly after delay
       { t:"pause",  delay }
     ============================================================ */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function makePlayer(bodyEl) {
    let token = 0; // invalidates in-flight playback on replay
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    async function typeInto(span, text, myToken, speed) {
      for (let i = 0; i < text.length; i++) {
        if (myToken !== token) return;
        span.textContent += text[i];
        await wait(speed);
      }
    }

    async function play(script) {
      const myToken = ++token;
      bodyEl.innerHTML = "";

      // persistent input cursor
      const cursor = document.createElement("span");
      cursor.className = "cursor";

      for (const step of script) {
        if (myToken !== token) return;

        if (step.t === "pause") {
          await wait(reduceMotion ? 0 : step.delay || 300);
          continue;
        }

        if (step.t === "prompt") {
          const line = document.createElement("span");
          line.className = "line";
          const prompt = document.createElement("span");
          prompt.className = "tprompt";
          prompt.textContent = "› ";
          const typed = document.createElement("span");
          typed.className = "tuser";
          line.appendChild(prompt);
          line.appendChild(typed);
          line.appendChild(cursor);
          bodyEl.appendChild(line);
          if (reduceMotion) {
            typed.textContent = step.text;
          } else {
            await typeInto(typed, step.text, myToken, step.speed || 26);
          }
          await wait(reduceMotion ? 0 : 360);
          continue;
        }

        if (step.t === "line") {
          await wait(reduceMotion ? 0 : step.delay != null ? step.delay : 120);
          if (myToken !== token) return;
          const line = document.createElement("span");
          line.className = "line " + (step.cls || "");
          line.innerHTML = step.html;
          // keep cursor at the very end
          bodyEl.appendChild(line);
          bodyEl.appendChild(cursor);
        }
      }
      // park cursor at end
      if (myToken === token) bodyEl.appendChild(cursor);
    }

    return { play, invalidate: () => token++ };
  }

  /* ---------- shared answer/cite builders ---------- */
  function cite(opts) {
    const recent = opts.recent ? " recent" : "";
    const tag = opts.recent ? ' <span class="tag-recent">most recent</span>' : "";
    return (
      `<span class="cite${recent}">` +
      `<span class="meta">[${opts.score}] <span class="who">${esc(opts.who)}</span> · ${esc(opts.when)}${tag}</span>` +
      `<span class="snip">${esc(opts.snip)}</span>` +
      `</span>`
    );
  }

  /* ============================================================
     HERO terminal script — the canonical SQS->Redis example,
     reversed-decision recency boost made visible.
     ============================================================ */
  function heroScript() {
    return [
      { t: "prompt", text: 'ask("why did we switch from SQS to Redis?")' },
      { t: "line", cls: "tdim", html: "embedding question · searching Team Brain …", delay: 480 },
      { t: "pause", delay: 420 },
      { t: "line", cls: "tmuted", html: "3 cited excerpts · similarity + recency", delay: 120 },
      {
        t: "line",
        delay: 220,
        html: cite({
          score: "0.91",
          who: "@maya",
          when: "2 days ago",
          recent: true,
          snip: '"Moved the queue to Redis Streams — sub-second fan-out and we already run Redis. SQS latency was killing the worker loop."',
        }),
      },
      {
        t: "line",
        delay: 260,
        html: cite({
          score: "0.88",
          who: "@dev",
          when: "3 weeks ago",
          snip: '"Picked SQS first for managed durability — fewer moving parts while we were still tiny."',
        }),
      },
      {
        t: "line",
        delay: 240,
        html: cite({
          score: "0.74",
          who: "@maya",
          when: "2 days ago",
          snip: '"Migration note: drained SQS, cut workers over to XREADGROUP, kept a dead-letter stream."',
        }),
      },
      { t: "line", cls: "tdim", html: "synthesizing …", delay: 460 },
      {
        t: "line",
        delay: 520,
        html:
          '<span class="answer"><span class="lbl">▌ agent answer</span>' +
          "You started on <b>SQS</b> for managed durability while the team was tiny, then <b>Maya moved the queue to Redis Streams two days ago</b> for sub-second fan-out — SQS latency was stalling the worker loop, and Redis was already in the stack. " +
          '<span class="tdim">The recency boost surfaces the current decision first, so the reversed one doesn\'t mislead.</span></span>',
      },
    ];
  }

  const heroBody = document.getElementById("heroBody");
  const heroPlayer = makePlayer(heroBody);

  // play hero when it scrolls into view (once)
  let heroPlayed = false;
  function playHero() {
    if (heroPlayed) return;
    heroPlayed = true;
    heroPlayer.play(heroScript());
  }

  document.getElementById("heroReplay").addEventListener("click", () => {
    heroPlayed = true;
    heroPlayer.play(heroScript());
  });

  /* ============================================================
     CROSS-TOOL tabbed demo.
     Left terminal = the asking tool. Right terminal = where the
     answer originated (the *other* tool), proving shared memory.
     ============================================================ */
  const crossBody = document.getElementById("crossBody");
  const crossBody2 = document.getElementById("crossBody2");
  const crossTitle = document.getElementById("crossTitle");
  const crossTitle2 = document.getElementById("crossTitle2");
  const crossPlayer = makePlayer(crossBody);
  const crossPlayer2 = makePlayer(crossBody2);

  const crossData = {
    claude: {
      askTitle: "claude code — ask",
      srcTitle: "codex — captured",
      ask: [
        { t: "prompt", text: 'ask("what auth are we using for the API?")' },
        { t: "line", cls: "tdim", html: "searching Team Brain …", delay: 460 },
        { t: "pause", delay: 360 },
        {
          t: "line",
          delay: 200,
          html: cite({
            score: "0.93",
            who: "@dev · in codex",
            when: "5 days ago",
            recent: true,
            snip: '"Went with short-lived JWTs + refresh rotation. Sessions in Postgres were too chatty for the edge."',
          }),
        },
        {
          t: "line",
          delay: 220,
          html: cite({
            score: "0.79",
            who: "@maya · in codex",
            when: "5 days ago",
            snip: '"Refresh tokens are httpOnly; access token lives 15 min."',
          }),
        },
        {
          t: "line",
          delay: 420,
          html:
            '<span class="answer"><span class="lbl">▌ claude answers</span>' +
            "Short-lived <b>JWTs with refresh rotation</b> — a call decided in <b>Codex</b>, answerable here without anyone re-explaining.</span>",
        },
      ],
      src: [
        { t: "line", cls: "tdim", html: "// session captured automatically", delay: 80 },
        { t: "prompt", text: "use JWT auth instead of db sessions?" },
        {
          t: "line",
          cls: "tmuted",
          delay: 200,
          html: 'reasoning kept → <span class="taccent">"short-lived JWTs + refresh rotation; sessions too chatty for the edge"</span>',
        },
        { t: "line", cls: "tdim", html: "tool: edited auth.ts · added refresh route", delay: 200 },
        { t: "line", cls: "tdim", html: "raw diff dropped · secrets scrubbed", delay: 180 },
        {
          t: "line",
          delay: 260,
          html: '<span class="taccent">↑ embedded → Team Brain</span>',
        },
      ],
    },
    codex: {
      askTitle: "codex — ask",
      srcTitle: "claude code — captured",
      ask: [
        { t: "prompt", text: 'ask("why is the cache TTL only 30s?")' },
        { t: "line", cls: "tdim", html: "searching Team Brain …", delay: 460 },
        { t: "pause", delay: 360 },
        {
          t: "line",
          delay: 200,
          html: cite({
            score: "0.90",
            who: "@maya · in claude",
            when: "yesterday",
            recent: true,
            snip: '"Dropped TTL to 30s after the pricing bug — stale prices were showing for minutes. 30s is the trade we agreed on."',
          }),
        },
        {
          t: "line",
          delay: 220,
          html: cite({
            score: "0.81",
            who: "@dev · in claude",
            when: "yesterday",
            snip: '"Anything longer and the dashboard lags reality; shorter and we hammer the origin."',
          }),
        },
        {
          t: "line",
          delay: 420,
          html:
            '<span class="answer"><span class="lbl">▌ codex answers</span>' +
            "It was cut to <b>30s after a pricing bug</b> showed stale prices — a deliberate freshness-vs-load trade made in <b>Claude Code</b>, retrieved here intact.</span>",
        },
      ],
      src: [
        { t: "line", cls: "tdim", html: "// session captured automatically", delay: 80 },
        { t: "prompt", text: "lower the cache TTL, prices going stale" },
        {
          t: "line",
          cls: "tmuted",
          delay: 200,
          html: 'reasoning kept → <span class="taccent">"30s TTL after pricing bug; freshness vs origin load trade"</span>',
        },
        { t: "line", cls: "tdim", html: "tool: edited cache.ts · TTL 300s → 30s", delay: 200 },
        { t: "line", cls: "tdim", html: "raw diff dropped · secrets scrubbed", delay: 180 },
        {
          t: "line",
          delay: 260,
          html: '<span class="taccent">↑ embedded → Team Brain</span>',
        },
      ],
    },
  };

  function playCross(key) {
    const d = crossData[key];
    crossTitle.textContent = d.askTitle;
    crossTitle2.textContent = d.srcTitle;
    crossPlayer.play(d.ask);
    crossPlayer2.play(d.src);
  }

  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      playCross(tab.dataset.tab);
    });
  });

  // play cross demo when it scrolls into view
  let crossPlayed = false;
  function playCrossOnce() {
    if (crossPlayed) return;
    crossPlayed = true;
    playCross("claude");
  }

  /* ============================================================
     INSIGHTS terminal — real `oh insights` shape; the point the
     animation lands on is the visibility line at the end.
     ============================================================ */
  function insightsScript() {
    return [
      { t: "prompt", text: "oh insights" },
      { t: "line", cls: "tmuted", html: 'your vibecoding · last 7 days <span class="tdim">· computed from sessions Oh already captured</span>', delay: 420 },
      { t: "line", cls: "tdim", html: "sessions 10 · exchanges 48", delay: 140 },
      { t: "pause", delay: 260 },
      { t: "line", html: '<span class="taccent">time at the wheel</span><span class="tdim"> ·</span> ~6h 12m', delay: 200 },
      { t: "line", cls: "tmuted", html: '  you prompting / thinking&nbsp;&nbsp;&nbsp;55m&nbsp;&nbsp;<span class="bar">▮▮</span><span class="bar dim">▮▮▮▮▮▮▮▮▮▮</span>', delay: 150 },
      { t: "line", cls: "tmuted", html: '  agent working&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;4h 35m&nbsp;&nbsp;<span class="bar">▮▮▮▮▮▮▮▮▮</span><span class="bar dim">▮▮▮</span>', delay: 150 },
      { t: "line", cls: "tmuted", html: '  you away (agent waited)&nbsp;&nbsp;41m&nbsp;&nbsp;<span class="bar">▮</span><span class="bar dim">▮▮▮▮▮▮▮▮▮▮▮</span>', delay: 150 },
      { t: "pause", delay: 280 },
      { t: "line", html: '<span class="taccent">tokens</span><span class="tdim"> ·</span> 5.1M fresh + 81.8M cache reads <span class="tdim">·</span> <span class="tblue">cache hit 95%</span>', delay: 200 },
      { t: "line", cls: "tmuted", html: '  most expensive exchange&nbsp;&nbsp;<span class="tamber">569k fresh tokens</span>', delay: 150 },
      { t: "pause", delay: 260 },
      { t: "line", html: '<span class="taccent">friction</span><span class="tdim"> ·</span> 2 corrections · 10 tool errors · <span class="taccent">0 rabbit-hole episodes</span>', delay: 200 },
      { t: "line", html: '<span class="taccent">fun</span><span class="tdim"> ·</span> peak hour 18:00 · longest session 1h 58m', delay: 170 },
      { t: "pause", delay: 420 },
      {
        t: "line",
        delay: 320,
        html:
          '<span class="answer"><span class="lbl">▌ visible to</span>' +
          '<b>you — and nobody else.</b> No <span class="k">--who</span>, no team tables, no manager roll-ups. ' +
          '<span class="tdim">Your team only ever sees what Oh deflected, never how you work.</span></span>',
      },
    ];
  }

  const insBody = document.getElementById("insBody");
  const insPlayer = makePlayer(insBody);

  let insPlayed = false;
  function playInsOnce() {
    if (insPlayed) return;
    insPlayed = true;
    insPlayer.play(insightsScript());
  }

  document.getElementById("insReplay").addEventListener("click", () => {
    insPlayed = true;
    insPlayer.play(insightsScript());
  });

  /* ---------- copy buttons ---------- */
  function wireCopy(btn, getText, label) {
    if (!btn) return;
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(getText()).then(
        () => {
          btn.textContent = "copied ✓";
          btn.classList.add("done");
          setTimeout(() => {
            btn.textContent = label;
            btn.classList.remove("done");
          }, 1600);
        },
        () => {
          btn.textContent = "press ⌘C";
        }
      );
    });
  }

  wireCopy(
    document.getElementById("copyBtn"),
    () =>
      [
        "git clone <this-repo> && cd oh",
        "npm install",
        "npm link",
        "oh init",
        "oh backfill",
      ].join("\n"),
    "copy"
  );

  const promptEl = document.getElementById("promptText");
  wireCopy(
    document.getElementById("copyPromptBtn"),
    () => (promptEl ? promptEl.innerText : ""),
    "copy prompt"
  );

  /* ---------- kick off reveal/trigger scanning ---------- */
  window.addEventListener("scroll", scanReveals, { passive: true });
  window.addEventListener("resize", scanReveals);
  window.addEventListener("load", scanReveals);
  scanReveals();
  // belt-and-suspenders: ensure nothing stays hidden if layout settles late
  setTimeout(scanReveals, 200);
  setTimeout(scanReveals, 800);
})();
