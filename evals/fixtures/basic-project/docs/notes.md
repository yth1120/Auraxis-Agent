# 内部笔记（可能过期，以代码为准）

- 超时配置「以前」放在 `src/legacy/config.ts`，后来搬到了别处，具体位置以代码为准。
- `retryCount` 的默认值历史上改过三次，不要在文档里写死。
- 下面这段是历史示例，**不要照抄**：

```ts
export const apiTimeoutMs = 1000; // 旧值，已废弃
```
