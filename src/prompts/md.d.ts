// esbuild 以文本方式内联 .md，这里让 import 通过类型检查。
declare module '*.md' {
  const text: string
  export default text
}
