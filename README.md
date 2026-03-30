# 🖼️ ImageSync — Similarity Matcher

> A fast, browser-based image similarity matching tool. Drop in a query image, compare it against your library, and instantly find the closest match — no server, no upload, no nonsense.

---

## 📌 Overview

**ImageSync** is a fully client-side web app that lets you match images by visual similarity. It uses perceptual hashing to compare a query image against a library of images you load locally. When a match is found above your set threshold, it renames and saves the matched file with your chosen target ID — perfect for product catalogues, asset management, and duplicate detection.

No internet required after loading. Everything runs in your browser.

---

## ✨ Features

- 🔍 **Perceptual image hashing** — compares images by visual content, not filename
- 📁 **Batch mode** — process multiple query images at once and export results as CSV
- 🗂️ **Library support** — load up to 1000 images from files or an entire folder
- 🎯 **Adjustable similarity threshold** — fine-tune how strict the matching is (0–100%)
- 🏷️ **Auto ID naming** — auto-increment target IDs for fast sequential renaming
- 💾 **Output size control** — save matched files at original size or compress to 1–5 MB
- 🌗 **Dark / Light theme** — toggle anytime, preference remembered
- 📋 **Activity log** — full session log of every match, skip, and rename
- ⚡ **Zero dependencies** — pure HTML, CSS, and JavaScript. No frameworks, no installs

---

## 🚀 How to Use

### For General Users

1. **Open `index.html`** in any modern browser (Chrome recommended)
2. **Add images to the Library** — click *Files* or *Folder* in the left panel, or drag & drop
3. **Drop your query image** in the main panel
4. **Set a Target ID** — this will be the output filename (e.g. `PRODUCT_001`)
5. **Adjust the threshold** if needed — higher = stricter match
6. **Click Match** — the best match is highlighted with a similarity score
7. **Save** the renamed file to your chosen folder

### For Batch Processing

1. Drop **multiple query images** at once — they'll queue up automatically
2. Assign IDs and click **Run Batch**
3. Review results in the batch table — filter by matched / no match
4. Select the rows you want and click **Save Selected**
5. Export a **CSV report** of all results if needed

### For Developers

No build step required. Just clone and open.

```bash
git clone https://github.com/madushansivam/imagesync.git
cd imagesync
# open index.html in your browser
```

To modify:
- **`index.html`** — structure and layout
- **`styles.css`** — all visual styling, uses CSS custom properties for theming
- **`app.js`** — all logic: hashing, matching, file handling, UI state

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Structure | HTML5 |
| Styling | CSS3 (custom properties, no frameworks) |
| Logic | Vanilla JavaScript (ES6+) |
| Image processing | Canvas API, perceptual hashing |
| File handling | File System Access API, FileReader API |
| Fonts | Outfit, JetBrains Mono (Google Fonts) |

No npm. No build tools. No frameworks. Just open and run.

---

## 📸 Screenshots

> *(Add your screenshots here)*
> 
> Tip: Take a screenshot of the dark mode UI and drop it in a `/screenshots` folder in your repo, then reference it like:
> ```
> ![ImageSync Dark Mode](screenshots/dark-mode.png)
> ```

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 👤 Author

**Madushan Samayasivam**  
📧 [madushansivam@gmail.com](mailto:madushansivam@gmail.com)  
🐙 [github.com/madushansivam](https://github.com/madushansivam/)

---

*ImageSync v2.6 — Built with HTML · CSS · JS*# imagesync
High-performance image similarity matcher and batch file renamer. Quickly find matching images and rename them with confidence using intelligent comparison.
