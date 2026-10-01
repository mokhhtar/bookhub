(function () {
  'use strict';

  var API = 'https://litheca-mind-reader-private-runtime-staging.mok243643.workers.dev';
  var ANSWERS = [
    ['yes', 'Yes'],
    ['probably_yes', 'Probably yes'],
    ['unknown', "I don't know"],
    ['probably_no', 'Probably no'],
    ['no', 'No']
  ];

  function byId(id) { return document.getElementById(id); }
  function escapeHTML(value) {
    var div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function request(route, payload) {
    return fetch(API + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || 'The game service is unavailable.');
        return data;
      });
    });
  }

  function initialize() {
    var card = byId('mr-card');
    var count = byId('mr-count');
    var pool = byId('mr-pool');
    var session = null;
    var busy = false;

    function failed(error) {
      busy = false;
      card.innerHTML = '<p class="mr-status">' + escapeHTML(error.message) + '</p>' +
        '<div class="mr-row mr-row--center"><button class="mr-btn" id="mr-retry">Try again</button></div>';
      byId('mr-retry').addEventListener('click', start);
    }

    function showQuestion(data) {
      session = data.session;
      count.textContent = 'Question ' + data.turn + ' of 30';
      pool.textContent = '';
      card.innerHTML = '<p class="mr-question">' + escapeHTML(data.question.text) + '</p>' +
        '<div class="mr-answers">' + ANSWERS.map(function (answer) {
          return '<button class="mr-btn" data-answer="' + answer[0] + '">' + answer[1] + '</button>';
        }).join('') + '</div>';
      Array.prototype.forEach.call(card.querySelectorAll('[data-answer]'), function (button) {
        button.addEventListener('click', function () {
          if (busy) return;
          busy = true;
          Array.prototype.forEach.call(card.querySelectorAll('button'), function (item) {
            item.disabled = true;
          });
          request('/v1/game/answer', {
            session: session,
            question: data.question.id,
            answer: button.getAttribute('data-answer')
          }).then(render).catch(failed);
        });
      });
      busy = false;
    }

    function showGuess(data) {
      session = data.session;
      var book = data.guess;
      count.textContent = 'My guess';
      pool.textContent = data.turn + ' questions';
      card.innerHTML = '<div class="mr-win">' +
        '<p class="mr-win-lead">Is it…</p>' +
        '<p class="mr-win-title">' + escapeHTML(book.title) + '</p>' +
        '<p class="mr-win-author">' + escapeHTML(book.author || '') +
          (book.year ? ' · ' + escapeHTML(book.year) : '') + '</p>' +
        '<div class="mr-row mr-row--center">' +
          '<button class="mr-btn mr-btn--primary" id="mr-guess-yes">That\'s the one</button>' +
          '<button class="mr-btn" id="mr-guess-no">No, keep going</button>' +
        '</div></div>';
      byId('mr-guess-yes').addEventListener('click', function () { answerGuess(true, book); });
      byId('mr-guess-no').addEventListener('click', function () { answerGuess(false, book); });
      busy = false;
    }

    function answerGuess(correct, book) {
      if (busy) return;
      busy = true;
      request('/v1/game/guess', { session: session, correct: correct })
        .then(function (data) {
          if (!data.done) return render(data);
          if (data.outcome === 'solved') return showFinished(book, data.questions);
          showGiveUp();
        }).catch(failed);
    }

    function showFinished(book, questions) {
      count.textContent = 'Solved';
      pool.textContent = questions + ' questions';
      card.innerHTML = '<div class="mr-win"><p class="mr-win-lead">Read your mind</p>' +
        '<p class="mr-win-title">' + escapeHTML(book.title) + '</p>' +
        '<p class="mr-win-author">' + escapeHTML(book.author || '') + '</p>' +
        '<div class="mr-row mr-row--center"><button class="mr-btn" id="mr-again">Play again</button></div></div>';
      byId('mr-again').addEventListener('click', start);
      busy = false;
    }

    function showGiveUp() {
      count.textContent = 'Not solved';
      pool.textContent = '';
      card.innerHTML = '<div class="mr-win"><p class="mr-win-title">You got me.</p>' +
        '<p class="mr-status">I could not identify the book this time. Find it below and teach me from your answers.</p>' +
        '<div class="mr-row"><input class="mr-search" id="mr-api-search" type="search" ' +
          'maxlength="80" autocomplete="off" placeholder="Book title or author" ' +
          'aria-label="Book title or author">' +
          '<button class="mr-btn" id="mr-api-search-btn">Search</button></div>' +
        '<p class="mr-result-note" id="mr-api-teach-note" style="margin-top:10px">' +
          'Choose the book you meant. Only that book and this game\'s answers will be sent.</p>' +
        '<ul class="mr-results" id="mr-api-results"></ul>' +
        '<div class="mr-row mr-row--center"><button class="mr-btn" id="mr-again">Play again</button></div></div>';
      byId('mr-again').addEventListener('click', start);
      byId('mr-api-search-btn').addEventListener('click', searchBooks);
      byId('mr-api-search').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); searchBooks(); }
      });
      busy = false;
    }

    function searchBooks() {
      if (busy) return;
      var input = byId('mr-api-search');
      var output = byId('mr-api-results');
      var note = byId('mr-api-teach-note');
      var query = input.value.trim();
      if (query.length < 2) {
        note.textContent = 'Enter at least two characters.';
        return;
      }
      busy = true;
      output.innerHTML = '';
      note.textContent = 'Searching…';
      request('/v1/game/search', { session: session, query: query })
        .then(function (data) {
          var results = data.results || [];
          if (!results.length) {
            note.textContent = 'No matching book was found in the game.';
            busy = false;
            return;
          }
          note.textContent = 'Select your book to teach the game.';
          output.innerHTML = results.map(function (book, index) {
            return '<li class="mr-result mr-result--pick" tabindex="0" data-book-index="' + index + '">' +
              '<strong>' + escapeHTML(book.title) + '</strong><br>' +
              '<span class="mr-result-note">' + escapeHTML(book.author || '') +
              (book.year ? ' · ' + escapeHTML(book.year) : '') + '</span></li>';
          }).join('');
          Array.prototype.forEach.call(output.querySelectorAll('[data-book-index]'), function (item) {
            function choose() { teachBook(results[Number(item.getAttribute('data-book-index'))]); }
            item.addEventListener('click', choose);
            item.addEventListener('keydown', function (event) {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
            });
          });
          busy = false;
        }).catch(failed);
    }

    function teachBook(book) {
      if (busy || !book) return;
      busy = true;
      var note = byId('mr-api-teach-note');
      note.textContent = 'Sending your answers…';
      request('/v1/game/teach', { session: session, book: book.key })
        .then(function () {
          note.textContent = 'Thanks — your answers were recorded. Several consistent games are required before the model changes.';
          byId('mr-api-results').innerHTML = '';
          byId('mr-api-search').disabled = true;
          byId('mr-api-search-btn').disabled = true;
          busy = false;
        }).catch(failed);
    }

    function render(data) {
      if (data.question) return showQuestion(data);
      if (data.guess) return showGuess(data);
      if (data.done) return showGiveUp();
      throw new Error('The game returned an invalid response.');
    }

    function start() {
      if (busy) return;
      busy = true;
      count.textContent = 'Starting…';
      pool.textContent = '';
      card.innerHTML = '<p class="mr-status">Choosing the first question…</p>';
      request('/v1/game/start', {}).then(render).catch(failed);
    }

    start();
  }

  window.bookMindReaderPrivateApi = { initialize: initialize };
}());
