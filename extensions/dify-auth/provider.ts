import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PROVIDER_ID, PROVIDER_LABEL, PROXY_PATH, DEFAULT_BASE_URL } from "./constants.js";
import { verifyDifyKey } from "./dify/client.js";
import { handleProxyRequest } from "./proxy/index.js";
import { createCompositeKey } from "./utils/auth.js";
import type { StreamFn } from "@mariozechner/pi-agent-core";

export const difyAuthPlugin = {
  id: "dify-auth",
  name: "Dify Auth",
  description: "Dify provider authentication and proxy",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // OpenClaw's responses client calls nested paths like /v1/responses under the
    // configured base URL, so the proxy route must stay publicly reachable and
    // prefix-match subpaths.
    api.registerHttpRoute({
      path: PROXY_PATH,
      auth: "plugin",
      match: "prefix",
      handler: handleProxyRequest,
    });

    // 2. Register Provider
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      auth: [
        {
          id: "dify-api-key",
          label: "Dify API Key",
          hint: "API Key & Base URL",
          kind: "api_key",
          run: async (ctx) => {
            // Ask for API Key
            const apiKey = await ctx.prompter.text({
              message: "Enter Dify App API Key",
              validate: (val) => (val?.trim().length > 5 ? undefined : "Invalid Key"),
            });

            // Ask for Base URL
            const baseUrl = await ctx.prompter.text({
              message: "Enter Dify API Base URL",
              initialValue: DEFAULT_BASE_URL,
              validate: (val) =>
                val?.startsWith("http") ? undefined : "Must start with http/https",
            });

            // Ask for App Type
            // const appType = await ctx.prompter.select({
            //   message: "Select App Type",
            //   options: [
            //     { value: "chat", label: "ChatFlow" },
            //     { value: "agent", label: "Agent" },
            //   ],
            // });
            const appType = "chat";

            // Verify Key
            const progress = ctx.prompter.progress("Verifying Dify API Key...");
            let siteInfo: { title?: string } = {};
            try {
              siteInfo = await verifyDifyKey(apiKey, baseUrl);
              progress.stop(`Verified: ${siteInfo.title || "Dify App"}`);
            } catch (err) {
              progress.stop("Verification failed");
              throw new Error(`Failed to verify key: ${String(err)}`, { cause: err });
            }

            // Construct Config Patch
            const compositeKey = createCompositeKey(apiKey, baseUrl, appType);

            // Resolve Gateway Port (default to 18789 if not found)
            const gatewayPort = ctx.config.gateway?.port ?? 18789;
            const proxyUrl = `http://127.0.0.1:${gatewayPort}${PROXY_PATH}`;

            // Determine Model ID
            const modelId = "chat-flow";
            const defaultName = "Dify ChatFlow";

            return {
              profiles: [
                {
                  profileId: `${PROVIDER_ID}:default`,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: compositeKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: proxyUrl,
                      apiKey: compositeKey,
                      api: "openai-responses",
                      models: [
                        {
                          id: modelId,
                          name: siteInfo.title || defaultName,
                          contextWindow: 128000,
                          maxTokens: 8192,
                          reasoning: false,
                          input: ["text", "image"],
                          cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                          },
                        },
                      ],
                    },
                  },
                },
                agents: {
                  defaults: {
                    model: {
                      primary: `${PROVIDER_ID}/${modelId}`,
                    },
                  },
                },
              },
            };
          },
        },
      ],
        // ★★ 新增：包装 streamFn，在 payload 里补 user 字段
        wrapStreamFn: ({ streamFn }) => {
            const underlying: StreamFn =
                // 如果上游没给 streamFn，就用默认的
                (streamFn as StreamFn | undefined) ?? ((model, context, options) =>
                    // 这里通常不会进来，真实项目里 core 会传进来
                    Promise.resolve() as any);
            return (model, context, options) => {
                // 只处理 openai-responses + 我们这个 provider
                if (model.api !== "openai-responses" || model.provider !== PROVIDER_ID) {
                    return underlying(model, context, options);
                }
                // 从 context 里拿 sessionId / sessionKey（名称取决于 pi-ai 版本）
                const rawSessionId =
                    // 根据实际情况二选一：大部分版本都有 sessionId
                    (context as any).sessionId ??
                    (context as any).sessionKey ??
                    undefined;
                const userFromSession =
                    typeof rawSessionId === "string" && rawSessionId.trim()
                        ? `oc-${rawSessionId.slice(0, 64)}` // 截断下，避免太长
                        : undefined;
                if (!userFromSession) {
                    // 没拿到 session 信息，就直接透传
                    return underlying(model, context, options);
                }
                const originalOnPayload = options?.onPayload;
                return underlying(model, context, {
                    ...options,
                    onPayload: (payload, m) => {
                        if (payload && typeof payload === "object") {
                            const obj = payload as Record<string, unknown>;
                            // 只在还没显式设置 user 时才填充
                            if (obj.user === undefined) {
                                obj.user = userFromSession;
                            }
                        }
                        return originalOnPayload?.(payload, m);
                    },
                });
            };
        }
    });
  },
};
