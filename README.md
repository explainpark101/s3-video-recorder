# S3 Video Recorder

화면 녹화를 S3에 저장하고, 선택적으로 RTMP로 동시 송출할 수 있는 웹 앱입니다.

## 라이브 시청 (실시간 스트리밍)

서버 설정에 **라이브 스트리밍 서버** URL을 입력하면 녹화와 동시에 실시간 시청이 가능합니다.

1. 시스템에 [ffmpeg](https://ffmpeg.org/) 설치
2. `bun run server` 또는 `npm run server`로 스트리밍 서버 실행 (기본 포트 3030)
3. 서버 설정에서 스트리밍 서버 URL 입력 (예: `ws://localhost:3030`)
4. 방송 시작 시 S3 녹화와 동시에 **http://localhost:3030/** 로 접속하여 실시간 시청 가능

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
