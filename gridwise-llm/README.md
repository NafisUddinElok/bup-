# GridWise LLM — Core Service

This directory contains the Node.js application for **GridWise LLM**, an LLM-assisted smart campus energy optimization microservice built for the **BUP CSE Fest 2026 Hackathon (Online Preliminary)**.

For complete project documentation, mathematical LP formulation, architecture diagrams, and benchmark evaluations, please refer to the [Root README](../README.md).

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env and supply your GEMINI_API_KEY
```

### 3. Run Validation Tests
```bash
npm test
```

### 4. Start the Server
- Development:
  ```bash
  npm run dev
  ```
- Production:
  ```bash
  npm start
  ```

## Available Scripts

- `npm start`: Runs `node src/index.js`
- `npm run dev`: Runs `nodemon src/index.js` with live reloading
- `npm test`: Executes `node test/validate-samples.js` against the 10 official public sample scenarios

