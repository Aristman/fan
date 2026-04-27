/**
 * FAN Chat — JCEF Chat Rendering Bridge
 *
 * Provides __fan_* functions called from Kotlin via JCEF executeJavaScript().
 * Uses IIFE wrapper pattern (no module exports — all functions on window).
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // INTERNAL STATE
  // ═══════════════════════════════════════════════════════════

  /** Braille spinner interval IDs keyed by element ID */
  var __fan_spinners = {};

  /** highlight.js load state */
  var __fan_hlLoaded = false;
  var __fan_hlLoading = false;

  /** Braille spinner frames — 10 frames at 80ms = 0.8s cycle */
  var SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  var SPINTERVAL_MS = 80;

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  function logError(fn, err) {
    console.error('[FAN Chat] ' + fn + ':', err);
  }

  function getContainer() {
    return document.getElementById('fan-messages-container');
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Start a braille spinner on the given DOM element.
   * Returns the interval ID (stored in __fan_spinners[id] as well).
   */
  function startSpinner(id, el) {
    var frame = 0;
    var iv = setInterval(function () {
      el.textContent = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      frame++;
    }, SPINTERVAL_MS);
    __fan_spinners[id] = iv;
    return iv;
  }

  /**
   * Get the computed CSS variable value for a given property name.
   */
  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ═══════════════════════════════════════════════════════════
  // 1. CORE DOM
  // ═══════════════════════════════════════════════════════════

  /**
   * Append raw HTML to #fan-messages-container.
   */
  function __fan_appendHtml(html) {
    try {
      var container = getContainer();
      if (!container) return;
      var div = document.createElement('div');
      div.innerHTML = html;
      while (div.firstChild) {
        container.appendChild(div.firstChild);
      }
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_appendHtml', e);
    }
  }

  /**
   * Replace entire body content (messages container) with new HTML.
   */
  function __fan_setBody(html) {
    try {
      var container = getContainer();
      if (!container) return;
      container.innerHTML = html;
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_setBody', e);
    }
  }

  /**
   * Clear all messages from the container.
   */
  function __fan_clear() {
    try {
      var container = getContainer();
      if (!container) return;
      container.innerHTML = '';
    } catch (e) {
      logError('__fan_clear', e);
    }
  }

  /**
   * Remove an element by its id attribute.
   */
  function __fan_removeElement(id) {
    try {
      var el = document.getElementById(id);
      if (el) el.parentNode.removeChild(el);
    } catch (e) {
      logError('__fan_removeElement', e);
    }
  }

  /**
   * Set innerHTML of element with given id.
   */
  function __fan_setElementHtml(id, html) {
    try {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    } catch (e) {
      logError('__fan_setElementHtml', e);
    }
  }

  /**
   * Set textContent of element with given id.
   */
  function __fan_setElementText(id, text) {
    try {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    } catch (e) {
      logError('__fan_setElementText', e);
    }
  }

  /**
   * Smooth-scroll to the bottom of the page.
   */
  function __fan_scrollToBottom() {
    try {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    } catch (e) {
      logError('__fan_scrollToBottom', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. MESSAGES
  // ═══════════════════════════════════════════════════════════

  /**
   * Append a user message bubble (right-aligned).
   */
  function __fan_addUserMessage(content) {
    try {
      var container = getContainer();
      if (!container) return;
      var div = document.createElement('div');
      div.className = 'fan-message';
      var bubble = document.createElement('div');
      bubble.className = 'fan-user-message';
      bubble.innerHTML = content;
      div.appendChild(bubble);
      container.appendChild(div);
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_addUserMessage', e);
    }
  }

  /**
   * Append an assistant message (full-width, transparent bg).
   */
  function __fan_addAssistantMessage(content) {
    try {
      var container = getContainer();
      if (!container) return;
      var div = document.createElement('div');
      div.className = 'fan-message';
      var msg = document.createElement('div');
      msg.className = 'fan-assistant-message';
      msg.innerHTML = content;
      div.appendChild(msg);
      container.appendChild(div);
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_addAssistantMessage', e);
    }
  }

  /**
   * Append a centered system message (muted, italic).
   */
  function __fan_addSystemMessage(text) {
    try {
      var container = getContainer();
      if (!container) return;
      var div = document.createElement('div');
      div.className = 'fan-system-message';
      div.textContent = text;
      container.appendChild(div);
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_addSystemMessage', e);
    }
  }

  /**
   * Append an error message block.
   */
  function __fan_addErrorMessage(title, message) {
    try {
      var container = getContainer();
      if (!container) return;
      var div = document.createElement('div');
      div.className = 'fan-error-message';

      var titleEl = document.createElement('div');
      titleEl.className = 'fan-error-title';
      titleEl.textContent = title;

      var bodyEl = document.createElement('div');
      bodyEl.className = 'fan-error-body';
      bodyEl.textContent = message;

      div.appendChild(titleEl);
      div.appendChild(bodyEl);
      container.appendChild(div);
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_addErrorMessage', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3. STREAMING
  // ═══════════════════════════════════════════════════════════

  var __fan_streamCounter = 0;

  /**
   * Create a streaming container and return its element ID.
   */
  function __fan_startAssistantStream() {
    try {
      __fan_streamCounter++;
      var id = 'fan-stream-' + __fan_streamCounter;

      var container = getContainer();
      if (!container) return id;

      var wrapper = document.createElement('div');
      wrapper.id = id;
      wrapper.className = 'fan-message';

      var msg = document.createElement('div');
      msg.className = 'fan-assistant-message';

      var contentDiv = document.createElement('div');
      contentDiv.id = id + '-content';

      var cursor = document.createElement('span');
      cursor.className = 'fan-streaming-cursor';
      cursor.id = id + '-cursor';

      msg.appendChild(contentDiv);
      msg.appendChild(cursor);
      wrapper.appendChild(msg);
      container.appendChild(wrapper);

      requestAnimationFrame(__fan_scrollToBottom);
      return id;
    } catch (e) {
      logError('__fan_startAssistantStream', e);
      return 'fan-stream-error';
    }
  }

  /**
   * Update the content of an active streaming container.
   */
  function __fan_updateAssistantStream(id, content) {
    try {
      var el = document.getElementById(id + '-content');
      if (el) el.innerHTML = content;
      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_updateAssistantStream', e);
    }
  }

  /**
   * End the stream — remove the blinking cursor.
   */
  function __fan_endAssistantStream(id) {
    try {
      var cursor = document.getElementById(id + '-cursor');
      if (cursor) cursor.parentNode.removeChild(cursor);
      requestAnimationFrame(__fan_scrollToBottom);
      // Trigger highlight on any new code blocks
      __fan_highlightAll();
    } catch (e) {
      logError('__fan_endAssistantStream', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4. THINKING / REASONING BLOCKS
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a reasoning/thinking block with a braille spinner.
   */
  function __fan_createReasoningBlock(id) {
    try {
      var container = getContainer();
      if (!container) return;

      var block = document.createElement('div');
      block.id = id;
      block.className = 'fan-thinking-block';

      // Header — clickable to toggle
      var header = document.createElement('div');
      header.className = 'fan-thinking-header';
      header.setAttribute('data-fan-toggle', id);

      var arrow = document.createElement('span');
      arrow.className = 'fan-thinking-arrow';
      arrow.textContent = '▾';

      var label = document.createElement('span');
      label.className = 'fan-thinking-label';
      label.textContent = 'Thinking…';

      var spinner = document.createElement('span');
      spinner.className = 'fan-thinking-spinner';
      spinner.id = id + '-spinner';

      header.appendChild(arrow);
      header.appendChild(label);
      header.appendChild(spinner);

      // Content area
      var content = document.createElement('div');
      content.className = 'fan-thinking-content';
      content.id = id + '-content';

      var text = document.createElement('div');
      text.className = 'fan-thinking-text';
      text.id = id + '-text';
      text.textContent = '';

      content.appendChild(text);

      block.appendChild(header);
      block.appendChild(content);
      container.appendChild(block);

      // Toggle handler
      header.addEventListener('click', function () {
        __fan_toggleReasoning(id);
      });

      // Start braille spinner
      startSpinner(id, spinner);

      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_createReasoningBlock', e);
    }
  }

  /**
   * Update the text content of a reasoning block.
   */
  function __fan_updateReasoningContent(id, content) {
    try {
      var el = document.getElementById(id + '-text');
      if (el) el.textContent = content;
    } catch (e) {
      logError('__fan_updateReasoningContent', e);
    }
  }

  /**
   * Complete a reasoning block — stop spinner, show ✓.
   */
  function __fan_completeReasoning(id) {
    try {
      // Clear the interval
      if (__fan_spinners[id]) {
        clearInterval(__fan_spinners[id]);
        delete __fan_spinners[id];
      }
      var spinner = document.getElementById(id + '-spinner');
      if (spinner) {
        spinner.textContent = '✓';
        spinner.style.color = getCSSVar('--fan-diff-added') || '#b5bd68';
      }

      // Update label
      var block = document.getElementById(id);
      if (block) {
        var label = block.querySelector('.fan-thinking-label');
        if (label) label.textContent = 'Thought for a while';
      }
    } catch (e) {
      logError('__fan_completeReasoning', e);
    }
  }

  /**
   * Toggle collapse/expand of a reasoning block.
   */
  function __fan_toggleReasoning(id) {
    try {
      var content = document.getElementById(id + '-content');
      var arrow = document.querySelector('#' + id + ' .fan-thinking-arrow');
      if (!content) return;

      if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        if (arrow) arrow.classList.remove('collapsed');
      } else {
        content.classList.add('collapsed');
        if (arrow) arrow.classList.add('collapsed');
      }
    } catch (e) {
      logError('__fan_toggleReasoning', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 5. TOOL CALL BLOCKS
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a tool call block.
   * @param {string} id - Unique element ID
   * @param {string} toolName - Display name of the tool
   * @param {string} status - "pending" | "success" | "error"
   * @param {string} icon - Emoji/icon for the tool
   * @param {string} summary - Short summary text
   */
  function __fan_addToolCallBlock(id, toolName, status, icon, summary) {
    try {
      var container = getContainer();
      if (!container) return;

      var statusClass = 'fan-tool-' + status;

      var block = document.createElement('div');
      block.id = id;
      block.className = 'fan-tool-block ' + statusClass;

      // Header
      var header = document.createElement('div');
      header.className = 'fan-tool-header';

      var arrow = document.createElement('span');
      arrow.className = 'fan-tool-arrow';
      arrow.textContent = '▾';

      var iconEl = document.createElement('span');
      iconEl.className = 'fan-tool-icon';
      iconEl.textContent = icon || '🔧';

      var nameEl = document.createElement('span');
      nameEl.className = 'fan-tool-name';
      nameEl.textContent = toolName;

      var summaryEl = document.createElement('span');
      summaryEl.className = 'fan-tool-summary';
      summaryEl.textContent = summary || '';

      var statusEl = document.createElement('span');
      statusEl.className = 'fan-tool-status';
      statusEl.id = id + '-status';
      statusEl.textContent = status === 'pending' ? '⏳' : (status === 'success' ? '✅' : '❌');

      header.appendChild(arrow);
      header.appendChild(iconEl);
      header.appendChild(nameEl);
      header.appendChild(summaryEl);
      header.appendChild(statusEl);

      // Content area (starts collapsed)
      var content = document.createElement('div');
      content.className = 'fan-tool-content collapsed';
      content.id = id + '-content';

      block.appendChild(header);
      block.appendChild(content);
      container.appendChild(block);

      // Toggle handler
      header.addEventListener('click', function () {
        __fan_toggleToolCall(id);
      });

      requestAnimationFrame(__fan_scrollToBottom);
    } catch (e) {
      logError('__fan_addToolCallBlock', e);
    }
  }

  /**
   * Update the status of a tool call block (pending → success/error).
   */
  function __fan_updateToolCallStatus(id, status) {
    try {
      var block = document.getElementById(id);
      if (!block) return;

      // Update status class
      block.classList.remove('fan-tool-pending', 'fan-tool-success', 'fan-tool-error');
      block.classList.add('fan-tool-' + status);

      // Update status icon
      var statusEl = document.getElementById(id + '-status');
      if (statusEl) {
        statusEl.textContent = status === 'pending' ? '⏳' : (status === 'success' ? '✅' : '❌');
      }
    } catch (e) {
      logError('__fan_updateToolCallStatus', e);
    }
  }

  /**
   * Set the result HTML content inside a tool call block.
   */
  function __fan_updateToolCallResult(id, resultHtml) {
    try {
      var content = document.getElementById(id + '-content');
      if (!content) return;

      content.innerHTML = '';

      var resultDiv = document.createElement('div');
      resultDiv.className = 'fan-tool-result';
      resultDiv.innerHTML = resultHtml;

      content.appendChild(resultDiv);
    } catch (e) {
      logError('__fan_updateToolCallResult', e);
    }
  }

  /**
   * Toggle collapse/expand of a tool call block.
   */
  function __fan_toggleToolCall(id) {
    try {
      var content = document.getElementById(id + '-content');
      var arrow = document.querySelector('#' + id + ' .fan-tool-arrow');
      if (!content) return;

      if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        if (arrow) arrow.classList.remove('collapsed');
      } else {
        content.classList.add('collapsed');
        if (arrow) arrow.classList.add('collapsed');
      }
    } catch (e) {
      logError('__fan_toggleToolCall', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 6. CODE — COPY & SYNTAX HIGHLIGHTING
  // ═══════════════════════════════════════════════════════════

  /**
   * Copy code from a code block to clipboard.
   * Called from onclick on the copy button.
   */
  function __fan_copyCode(button) {
    try {
      // Find the code element within the same code-block
      var codeBlock = button.closest('.fan-code-block');
      if (!codeBlock) return;

      var codeEl = codeBlock.querySelector('pre code') || codeBlock.querySelector('pre');
      if (!codeEl) return;

      var text = codeEl.textContent || codeEl.innerText;

      // Try clipboard API first, fall back to execCommand
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          __fan_markCopied(button);
        }).catch(function () {
          __fan_fallbackCopy(text, button);
        });
      } else {
        __fan_fallbackCopy(text, button);
      }
    } catch (e) {
      logError('__fan_copyCode', e);
    }
  }

  function __fan_fallbackCopy(text, button) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      __fan_markCopied(button);
    } catch (e) {
      // Silent failure — clipboard not available
    }
  }

  function __fan_markCopied(button) {
    if (!button) return;
    var orig = button.textContent;
    button.textContent = '✓ Copied';
    button.classList.add('copied');
    setTimeout(function () {
      button.textContent = orig;
      button.classList.remove('copied');
    }, 1500);
  }

  /**
   * Lazy-load highlight.js from CDN.
   */
  function __fan_initHl() {
    try {
      if (__fan_hlLoaded || __fan_hlLoading) return;
      __fan_hlLoading = true;

      var script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
      script.onload = function () {
        __fan_hlLoaded = true;
        __fan_hlLoading = false;
        // Highlight any blocks that accumulated while loading
        __fan_highlightAll();
      };
      script.onerror = function () {
        __fan_hlLoading = false;
        console.warn('[FAN Chat] Failed to load highlight.js');
      };
      document.head.appendChild(script);
    } catch (e) {
      __fan_hlLoading = false;
      logError('__fan_initHl', e);
    }
  }

  /**
   * Highlight all unhighlighted code blocks.
   */
  function __fan_highlightAll() {
    try {
      if (typeof hljs === 'undefined') {
        // Try to load it
        __fan_initHl();
        return;
      }

      var blocks = document.querySelectorAll('pre code:not(.hljs)');
      for (var i = 0; i < blocks.length; i++) {
        hljs.highlightElement(blocks[i]);
      }
    } catch (e) {
      logError('__fan_highlightAll', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 7. THEME
  // ═══════════════════════════════════════════════════════════

  /**
   * Set the theme on <html>.
   * @param {boolean} isDark - true → dark, false → light
   */
  function __fan_updateTheme(isDark) {
    try {
      document.documentElement.setAttribute(
        'data-fan-theme',
        isDark ? 'dark' : 'light'
      );
    } catch (e) {
      logError('__fan_updateTheme', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 8. FOOTER
  // ═══════════════════════════════════════════════════════════

  /**
   * Update the footer bar with session metadata.
   * @param {Object} data - JSON object with keys:
   *   cwd, branch, sessionName, statsUp, statsDown, statsRead,
   *   cost, contextUsed, contextMax, modelName, temperature
   */
  function __fan_updateFooter(data) {
    try {
      if (!data) return;

      // Line 1: cwd, branch, sessionName
      var cwd = data.cwd || '';
      var branch = data.branch || '';
      var sessionName = data.sessionName || '';

      var cwdEl = document.getElementById('fan-footer-cwd');
      var branchEl = document.getElementById('fan-footer-branch');
      var sessionEl = document.getElementById('fan-footer-session');

      if (cwdEl) cwdEl.textContent = cwd;
      if (branchEl) branchEl.textContent = branch ? (' ' + branch) : '';
      if (sessionEl) sessionEl.textContent = sessionName ? (' ' + sessionName) : '';

      // Line 2: stats, context, model
      var parts = [];
      if (data.statsUp) parts.push('↑' + data.statsUp);
      if (data.statsDown) parts.push('↓' + data.statsDown);
      if (data.statsRead) parts.push('📖' + data.statsRead);
      if (data.cost !== undefined && data.cost !== null) parts.push('$' + data.cost);

      var statsEl = document.getElementById('fan-footer-stats');
      if (statsEl) statsEl.textContent = parts.join('  ');

      var ctxEl = document.getElementById('fan-footer-context');
      var ctxMaxEl = document.getElementById('fan-footer-context-max');

      if (ctxEl) {
        ctxEl.textContent = data.contextUsed || '0';
        // Color based on usage ratio
        var used = parseInt(data.contextUsed, 10) || 0;
        var max = parseInt(data.contextMax, 10) || 1;
        var ratio = used / max;
        ctxEl.classList.remove('fan-context-normal', 'fan-context-warning', 'fan-context-critical');
        if (ratio < 0.7) {
          ctxEl.classList.add('fan-context-normal');
        } else if (ratio < 0.9) {
          ctxEl.classList.add('fan-context-warning');
        } else {
          ctxEl.classList.add('fan-context-critical');
        }
      }

      if (ctxMaxEl) ctxMaxEl.textContent = data.contextMax || '';

      // Model + temperature
      var modelParts = [];
      if (data.modelName) modelParts.push(data.modelName);
      if (data.temperature !== undefined && data.temperature !== null) {
        modelParts.push('t=' + data.temperature);
      }

      var modelEl = document.getElementById('fan-footer-model');
      if (modelEl) modelEl.textContent = modelParts.join(' ');
    } catch (e) {
      logError('__fan_updateFooter', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — attach all functions to window
  // ═══════════════════════════════════════════════════════════

  // Core DOM
  window.__fan_appendHtml = __fan_appendHtml;
  window.__fan_setBody = __fan_setBody;
  window.__fan_clear = __fan_clear;
  window.__fan_removeElement = __fan_removeElement;
  window.__fan_setElementHtml = __fan_setElementHtml;
  window.__fan_setElementText = __fan_setElementText;
  window.__fan_scrollToBottom = __fan_scrollToBottom;

  // Messages
  window.__fan_addUserMessage = __fan_addUserMessage;
  window.__fan_addAssistantMessage = __fan_addAssistantMessage;
  window.__fan_addSystemMessage = __fan_addSystemMessage;
  window.__fan_addErrorMessage = __fan_addErrorMessage;

  // Streaming
  window.__fan_startAssistantStream = __fan_startAssistantStream;
  window.__fan_updateAssistantStream = __fan_updateAssistantStream;
  window.__fan_endAssistantStream = __fan_endAssistantStream;

  // Thinking
  window.__fan_createReasoningBlock = __fan_createReasoningBlock;
  window.__fan_updateReasoningContent = __fan_updateReasoningContent;
  window.__fan_completeReasoning = __fan_completeReasoning;
  window.__fan_toggleReasoning = __fan_toggleReasoning;

  // Tool Calls
  window.__fan_addToolCallBlock = __fan_addToolCallBlock;
  window.__fan_updateToolCallStatus = __fan_updateToolCallStatus;
  window.__fan_updateToolCallResult = __fan_updateToolCallResult;
  window.__fan_toggleToolCall = __fan_toggleToolCall;

  // Code
  window.__fan_copyCode = __fan_copyCode;
  window.__fan_initHl = __fan_initHl;
  window.__fan_highlightAll = __fan_highlightAll;

  // Theme
  window.__fan_updateTheme = __fan_updateTheme;

  // Footer
  window.__fan_updateFooter = __fan_updateFooter;

  // Spinner state (for cleanup if needed)
  window.__fan_spinners = __fan_spinners;

})();
