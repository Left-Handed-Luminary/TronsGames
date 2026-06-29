# TronsGames

A small arcade-style game collection built as an experiment in rapid AI-assisted development.

This site is hosted inside of github. To play the games:
https://left-handed-luminary.github.io/TronsGames/


This repository contains a set of self-contained browser games. Each game was generated in one shot with Gemini as a single-page HTML file, then saved as an individual playable page. The goal was to test how far a modern AI coding assistant can go from prompt to playable prototype without a traditional multi-file project structure.

## About the Project

TronsGames explores a simple idea:

> Can AI generate complete, playable web games as standalone pages from a single prompt?

Each game in this repository keeps everything in one HTML file:

- HTML structure
- CSS styling
- JavaScript game logic
- Game loop and input handling
- Canvas or DOM-based rendering where needed

This makes every game easy to open, inspect, modify, and share.

## Games

The repository includes several one-page games and experiments, including:

| Game File | Description |
|---|---|
| `agalag.html` | Retro arcade shooter inspired by classic space shooters |
| `asteroid-clone.html` | Asteroids-style browser game prototype |
| `chromatic-drift.html` | Color and movement based arcade experiment |
| `cootie-catcher.html` | Interactive fortune-teller style game |
| `davidic-lyre.html` | Music-inspired interactive experiment |
| `defender-clone.html` | Defender-style arcade prototype |
| `ghostboy.html` | Character-based browser game experiment |
| `mega-minesweeper.html` | Expanded Minesweeper-style puzzle game |
| `mergation.html` | Merge-style browser game prototype |
| `vector-maze.html` | Vector-line sliding maze puzzle game |
| `wordle-clone.html` | Wordle-style word puzzle game |

## How to Run

No build tools are required.

1. Clone the repository.
2. Open any `.html` file in a modern browser.
3. Play the game.

Example:

```bash
git clone https://github.com/Left-Handed-Luminary/TronsGames.git
cd TronsGames
```

Then open one of the HTML files directly, such as:

```text
wordle-clone.html
```

You can also serve the folder locally if your browser blocks local file behavior:

```bash
python -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```

## Why Single-Page Games?

Single-page games are useful for fast prototyping because they reduce setup overhead.

Benefits:

- No framework required
- No bundler required
- No package install required
- Easy to read and modify
- Easy to host on GitHub Pages
- Easy to compare AI-generated coding approaches

This repository works as both a game collection and a snapshot of AI-assisted development in practice.

## AI-Assisted Development Note

These games were generated with Gemini in one shot, with each game created as a complete standalone HTML page.

The repository reflects an experiment in prompt-driven software creation, rapid prototyping, and AI-generated game design. Some games may still need polish, bug fixes, accessibility improvements, mobile tuning, or better scoring systems.

## Possible Future Improvements

Planned or possible enhancements:

- Add screenshots or GIF previews for each game
- Add a playable gallery landing page
- Improve mobile controls
- Add sound effects and music
- Add high-score persistence with `localStorage`
- Normalize keyboard and touch input patterns
- Refactor shared patterns into reusable utilities
- Add accessibility notes for color, keyboard navigation, and screen reader behavior

## Tech Stack

- HTML
- CSS
- JavaScript
- Browser APIs
- AI-assisted generation with Gemini

## Author

Created by Brian Bass.

- GitHub: [Left-Handed-Luminary](https://github.com/Left-Handed-Luminary)
- LinkedIn: [Brian Bass](https://www.linkedin.com/in/brianaldenbass)

Brian is a software architect and developer exploring AI-assisted coding, rapid prototyping, modernization, and creative software experiments.

## Repository

TronsGames on GitHub:

<https://github.com/Left-Handed-Luminary/TronsGames>

## License

No license file is currently included in this README draft.

If you want others to freely use or modify these games, consider adding a license such as MIT. If you want to reserve all rights, add an explicit copyright notice instead.
