# PaperForge

PaperForge converts DOCX manuscripts into editable, venue-ready LaTeX projects. It helps researchers preserve their content, review validation findings, and download source files, PDFs, and reports.

## Features

- Convert DOCX manuscripts to LaTeX
- Support for IEEE and ACM templates
- Track conversion and validation progress
- Review suggested repairs before applying them
- Download generated source, PDF, and reports
- Optional Gemini or OpenAI-assisted reasoning

## Getting Started

### Requirements

- Node.js 20 or later
- npm
- A LaTeX installation for local PDF compilation (optional)

### Installation

```bash
git clone <repository-url>
cd PaperForge
npm install
```

Copy `.env.example` to `.env` and add an API key if you want AI-assisted suggestions. PaperForge can run without one using its rule-based fallback.

```bash
npm run dev
```

Open [http://localhost:4174](http://localhost:4174) in your browser.

## Available Commands

```bash
npm run dev          # Start the development server
npm test             # Run the test suite
npm run test:coverage # Run tests with coverage
npm run lint         # Check code style
npm run build        # Run the build checks
```

## Docker

```bash
docker build -t paperforge .
docker run --rm -p 4174:4174 --env-file .env paperforge
```

The Docker image includes the LaTeX tools required for PDF compilation.

## Privacy

Uploaded manuscripts are stored temporarily for processing and are not used for training without consent.

## License

No license has been specified yet.
