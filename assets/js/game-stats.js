/**
 * game-stats.js — reports a finished game to the counter, and reads back how
 * everyone else did. Shared by Guess the Book and Spot the Slop.
 *
 * One file rather than a copy per game, deliberately: the summary/book-page
 * templates in this repo are two hand-synced copies and they have drifted
 * before. Two games with two copies of a network contract would drift the
 * same way, and the second copy is always the one nobody remembers to fix.
 *
 * THE RULE THIS FILE OBEYS ABOVE ALL: none of it may affect the game. Every
 * entry point swallows its own failures. A blocked script, an ad blocker
 * eating Turnstile, an offline player, a Worker outage — all of them must
 * leave the win screen, the share card and the local stats exactly as they
 * are. The counter is a nice-to-have bolted onto a game that already works
 * without it, and it stays that way.
 */
(function () {
  "use strict";

  var API = "https://games-stats.litheca.com";
  var SITE_KEY = "0x4AAAAAAEFRsOtSp52c-H1Q";
  var TURNSTILE_SRC =
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

  // A random string, not an identity. It exists so the same browser cannot
  // inflate one day's count by replaying, and for nothing else: it is never
  // sent anywhere but this counter, never joined to an account, and clearing
  // site data throws it away with no consequence beyond one extra row.
  //
  // Its own key, not folded into bh_gtb_v1 / bh_sts_v1 — those carry a
  // version the games check, and adding a field would mean bumping both for a
  // change that has nothing to do with either game's state.
  var PLAYER_KEY = "bh_player_v1";

  function playerId() {
    try {
      var id = localStorage.getItem(PLAYER_KEY);
      if (id && id.length >= 8) return id;
      id = (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(PLAYER_KEY, id);
      return id;
    } catch (e) {
      // Private browsing, storage disabled, quota. No id means no report;
      // the game is unaffected.
      return null;
    }
  }

  // ── Turnstile, loaded only when a game actually finishes ────
  //
  // render=explicit plus a manual execute(), so nothing runs for the many
  // people who open the page and leave. It is invisible: no widget, no
  // checkbox, nothing for the player to do or notice.
  var scriptPromise = null;

  function loadTurnstile() {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve, reject) {
      if (window.turnstile) return resolve(window.turnstile);
      var s = document.createElement("script");
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.defer = true;
      s.onload = function () {
        window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile"));
      };
      s.onerror = function () { reject(new Error("turnstile blocked")); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function getToken() {
    return loadTurnstile().then(function (turnstile) {
      return new Promise(function (resolve, reject) {
        var host = document.createElement("div");
        host.style.display = "none";
        document.body.appendChild(host);
        // Belt and braces: if Turnstile neither resolves nor errors we must
        // not leave a pending promise holding a DOM node forever.
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; cleanup(); reject(new Error("turnstile timeout")); }
        }, 12000);
        function cleanup() {
          clearTimeout(timer);
          try { turnstile.remove(id); } catch (e) {}
          try { host.remove(); } catch (e) {}
        }
        var id = turnstile.render(host, {
          sitekey: SITE_KEY,
          size: "invisible",
          callback: function (token) {
            if (done) return;
            done = true; cleanup(); resolve(token);
          },
          "error-callback": function () {
            if (done) return;
            done = true; cleanup(); reject(new Error("turnstile error"));
          },
        });
        try { turnstile.execute(id); } catch (e) {
          if (!done) { done = true; cleanup(); reject(e); }
        }
      });
    });
  }

  /**
   * Report a finished game. `score` is guesses-used for Guess the Book (1-6)
   * and pairs-spotted for Spot the Slop (0-5) — the Worker knows each game's
   * range, so zero is a real result there rather than an error.
   *
   * Returns a promise that NEVER rejects. Callers are not expected to await
   * it and must not branch on it.
   */
  function report(game, day, score) {
    var player = playerId();
    if (!player) return Promise.resolve(false);
    return getToken()
      .then(function (token) {
        return fetch(API + "/solved", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ game: game, day: day, player: player, guesses: score, token: token }),
        });
      })
      .then(function (res) { return res.ok; })
      .catch(function () { return false; });
  }

  /**
   * How everyone else did today. Resolves to null when there is nothing to
   * show — which includes the Worker withholding counts below its reporting
   * floor, so a caller that renders only on a non-null result cannot
   * accidentally display "3 people solved today".
   */
  function stats(game, day) {
    return fetch(API + "/stats?game=" + encodeURIComponent(game) + "&day=" + encodeURIComponent(day), {
      signal: AbortSignal.timeout(8000),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || data.enough !== true) return null;
        if (!Array.isArray(data.dist) || typeof data.solvers !== "number") return null;
        return data;
      })
      .catch(function () { return null; });
  }

  window.bhGameStats = { report: report, stats: stats };
})();
