// src/js/init/initMarkdown.js
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
// 你可以选择一个你喜欢的主题。这里以 'github.min.css' 为例，与你之前 CDN 使用的一致。
// 如果你想使用其他主题，请相应修改路径。
// import 'highlight.js/styles/github.min.css';
import 'highlight.js/styles/atom-one-dark.min.css'; // 引入新的 atom-one-dark 主题


function initMarkdownRenderer() {
    if (typeof MarkdownIt === 'function' && typeof hljs !== 'undefined') {
        md = new MarkdownIt({
            html: true,
            breaks: true,
            langPrefix: 'language-',
            linkify: true,
            typographer: false,
            quotes: '“”‘’',
            highlight: function (str, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return '<pre class="hljs"><code>' + hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
                    } catch (e) {
                        console.error("[HLJS] Error:", e);
                    }
                }
                return '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre>';
            }
        });
        console.log("[MD RENDERER] markdown-it initialized.");
    } else {
        console.error("[MD RENDERER] MarkdownIt or hljs not available. Using basic fallback.");
        md = { render: (text) => escapeHtml(String(text)).replace(/\n/g, '<br>') };
    }
}

function renderLatexInElement(element) {
    if (!element) return;
    try {
        // 直接调用导入的 renderMathInElement (它应该在文件顶部被 import)
        renderMathInElement(element, { 
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false,
            ignoredClasses: ["no-katex-render", "hljs", "no-math", "highlight", "language-"]
        });
    } catch (error) {
        console.error("[KaTeX] Rendering error (通过 import):", error, "on element:", element);
    }
}


/**
 * 初始化主题选择器的事件监听和初始主题加载。
 */
function initThemeSelector() {
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector) {
        themeSelector.addEventListener('change', (event) => {
            applyTheme(event.target.value);
        });
    }
    // 在所有UI元素都可能已加载后应用初始主题
    loadAndApplyInitialTheme();
}