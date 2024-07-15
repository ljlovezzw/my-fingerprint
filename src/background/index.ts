import { compareVersions, genRandomSeed, urlToHttpHost } from "@/utils/base";
import { debounce } from "@/utils/timer";
import deepmerge from "deepmerge";
import { HookType, RuntimeMsg } from '@/types/enum'
import { randomEquipmentInfo } from "@/utils/data";
import { selectTabByHost, sendMessageToAllTags } from "@/utils/tabs";
import { tabUpdateScriptState } from "@/message/tabs";

const UA_NET_RULE_ID = 1

const SPECIAL_KEYS: (keyof HookFingerprint['other'])[] = ['canvas', 'audio', 'webgl', 'webrtc', 'timezone']

let localStorage: LocalStorageObject | undefined
const hookRecords = new Map<number, Partial<Record<HookFingerprintKey, number>>>()

const userAgentCache: Partial<Record<HookType, string>> = {}

const BADGE_COLOR = {
  whitelist: '#fff',
  low: '#7FFFD4',
  high: '#F4A460',
}

// /**
//  * 获取请求头
//  */
// const getUserAgent = (tabId: number, url: string) => {
//   // 扩展未开启
//   if(!localStorage?.config.enable) return undefined
//   // url无效
//   const host = urlToHttpHost(url)
//   if (!host) return undefined
//   // 在白名单
//   if (localStorage.whitelist.has(host)) return undefined

//   const mode = localStorage?.config.fingerprint.navigator.userAgent
//   switch (mode?.type) {
//     case HookType.value: {
//       return mode.value
//     }
//     case HookType.page: {
//       return randomEquipmentInfo(tabId).userAgent
//     }
//     case HookType.domain: {
//       return randomEquipmentInfo(hashNumberFromString(host)).userAgent
//     }
//     case HookType.browser: {
//       let ua = userAgentCache[HookType.browser]
//       if(!ua){
//         ua = randomEquipmentInfo(localStorage?.config.browserSeed ?? genRandomSeed()).userAgent
//         userAgentCache[HookType.browser] = ua
//       }
//       return ua
//     }
//     case HookType.seed: {
//       let ua = userAgentCache[HookType.seed]
//       if(!ua){
//         ua = randomEquipmentInfo(localStorage?.config.customSeed ?? genRandomSeed()).userAgent
//         userAgentCache[HookType.browser] = ua
//       }
//       return ua
//     }
//     case HookType.default:
//     default: return undefined
//   }
// }

/**
 * 获取请求头
 */
const getUserAgent = () => {
  if(!localStorage?.config.enable || !localStorage?.config.hookNetRequest) return undefined
  const mode = localStorage?.config.fingerprint.navigator.userAgent
  switch (mode?.type) {
    case HookType.value: {
      return mode.value
    }
    case HookType.browser: {
      let ua = userAgentCache[HookType.browser]
      if(!ua){
        ua = randomEquipmentInfo(localStorage?.config.browserSeed ?? genRandomSeed()).userAgent
        userAgentCache[HookType.browser] = ua
      }
      return ua
    }
    case HookType.seed: {
      let ua = userAgentCache[HookType.seed]
      if(!ua){
        ua = randomEquipmentInfo(localStorage?.config.customSeed ?? genRandomSeed()).userAgent
        userAgentCache[HookType.seed] = ua
      }
      return ua
    }
    default: return undefined
  }
}

/**
 * 刷新请求头UA
 */
const refreshRequestHeaderUA = () => {
  const ua = getUserAgent()
  if(ua === undefined){
    chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds: [UA_NET_RULE_ID]})
  }else{
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [UA_NET_RULE_ID],
      addRules: [{
        id: UA_NET_RULE_ID,
        // priority: 1,
        condition: {},
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [{
            header: "User-Agent",
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: getUserAgent(),
          }]
        },
      }],
    })
  }
}

/**
 * 生成默认配置
 */
const genDefaultLocalStorage = (): LocalStorage => {
  const manifest = chrome.runtime.getManifest()
  const defaultHook: BaseHookMode = { type: HookType.default }
  const browserHook: BaseHookMode = { type: HookType.browser }
  return {
    version: manifest.version,
    config: {
      enable: true,
      customSeed: genRandomSeed(),
      browserSeed: genRandomSeed(),
      fingerprint: {
        navigator: {
          appVersion: browserHook,
          platform: browserHook,
          userAgent: browserHook,
          language: defaultHook,
          hardwareConcurrency: defaultHook,
        },
        screen: {
          height: defaultHook,
          width: defaultHook,
          colorDepth: defaultHook,
          pixelDepth: defaultHook,
        },
        other: {
          timezone: defaultHook,
          canvas: browserHook,
          audio: browserHook,
          webgl: defaultHook,
          webrtc: defaultHook,
        },
      },
      language: navigator.language,
      hookNetRequest: true,
      hookBlankIframe: true,
    },
    whitelist: []
  }
}

/**
 * 初始化默认配置
 */
const initLocalConfig = (previousVersion: string | undefined) => {
  if(localStorage)return

  chrome.storage.local.get()
  .then(async (data: Partial<LocalStorage>) => {
    if(localStorage)return
    if (
      // 其中一个版本号不存
      (!data.version || !previousVersion) ||
      // 配置版本号小于2.0.0
      (compareVersions(data.version, '2.0.0') < 0)
    ) {
      // 清空存储并使用设置存储为默认值
      await chrome.storage.local.clear()
      const temp = genDefaultLocalStorage()
      localStorage = { ...temp, whitelist: new Set(temp.whitelist) }
      return await chrome.storage.local.set(temp)
    } else {
      localStorage = { ...data, whitelist: new Set(data.whitelist) } as LocalStorageObject
      localStorage.config.browserSeed = genRandomSeed()
      return await chrome.storage.local.set({ config: localStorage.config })
    }
  })
  .then(() => {
    refreshRequestHeaderUA()
  })
}

/**
 * 存储配置
 */
const saveLocalConfig = debounce(() => {
  localStorage && chrome.storage.local.set({ config: localStorage.config })
}, 500)

/**
 * 存储白名单
 */
const saveLocalWhitelist = debounce(() => {
  localStorage && chrome.storage.local.set({ whitelist: [...localStorage.whitelist] })
}, 500)

/**
 * 修改配置
 */
const updateLocalConfig = (config: DeepPartial<LocalStorageConfig>) => {
  if (!localStorage?.config) return
  localStorage.config = deepmerge<LocalStorageConfig, DeepPartial<LocalStorageConfig>>(localStorage.config, config)
  saveLocalConfig()
  if(config.enable !== undefined || config.hookNetRequest !== undefined || config.fingerprint?.navigator?.userAgent){
    refreshRequestHeaderUA()
  }
}

/**
 * 修改白名单
 */
const updateLocalWhitelist = (type: 'add' | 'del', host: string | string[]) => {
  if (!localStorage?.whitelist) return
  if(Array.isArray(host)){
    if (type === 'add') {
      for(const hh of host){
        localStorage.whitelist.add(hh)
      }
    } else if (type === 'del') {
      for(const hh of host){
        localStorage.whitelist.delete(hh)
      }
    }
  }else{
    if (type === 'add') {
      localStorage.whitelist.add(host)
    } else if (type === 'del') {
      localStorage.whitelist.delete(host)
    }
  }
  saveLocalWhitelist()
}

/**
 * 获取Badge内容
 * @returns [文本, 颜色]
 */
const getBadgeContent = (records: Partial<Record<HookFingerprintKey, number>>): [string, string] => {
  let baseNum = 0
  let specialNum = 0
  for (const [key, num] of Object.entries(records)) {
    if (SPECIAL_KEYS.includes(key as any)) {
      specialNum += num
    } else {
      baseNum += num
    }
  }
  return [String(specialNum || baseNum), specialNum ? BADGE_COLOR.high : BADGE_COLOR.low]
}

/**
 * 设置白名单标识
 */
const setBadgeWhitelist = (tabId: number) => {
  chrome.action.setBadgeText({ tabId, text: ' ' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR.whitelist })
}

/**
 * 移除标识
 */
const remBadge = (tabId: number) => {
  chrome.action.setBadgeText({ tabId, text: '' })
}

/**
 * 初次启动扩展时触发（浏览器更新、扩展更新触发）
 */
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (
    reason === chrome.runtime.OnInstalledReason.INSTALL ||
    reason === chrome.runtime.OnInstalledReason.UPDATE
  ) {
    initLocalConfig(previousVersion)
  }
});

/**
 * 重启浏览器触发
 */
chrome.runtime.onStartup.addListener(() => {
  initLocalConfig(chrome.runtime.getManifest().version)
});

/**
 * 消息处理
 */
chrome.runtime.onMessage.addListener((msg: MsgRequest, sender, sendResponse: RespFunc) => {
  switch (msg.type) {
    case RuntimeMsg.SetConfig: {
      updateLocalConfig(msg.config)
      sendMessageToAllTags<SetConfigRequest>({
        type: RuntimeMsg.SetConfig,
        config: msg.config
      })
      break
    }
    case RuntimeMsg.GetNotice: {
      const isWhitelist = localStorage?.whitelist.has(msg.host);
      (sendResponse as RespFunc<GetNoticeMsg>)(isWhitelist ?
        {
          type: 'whitelist',
        } : {
          type: 'record',
          data: hookRecords.get(msg.tabId)
        })
      break
    }
    case RuntimeMsg.SetHookRecords: {
      const tabId = sender.tab?.id
      if (tabId === undefined) return
      hookRecords.set(tabId, msg.data)
      const [text, color] = getBadgeContent(msg.data)
      chrome.action.setBadgeText({ tabId, text });
      chrome.action.setBadgeBackgroundColor({ tabId, color });
      break
    }
    case RuntimeMsg.UpdateWhitelist: {
      if(msg.mode === 'add'){
        updateLocalWhitelist('add', msg.host)
        selectTabByHost(msg.host).then((tabs) => tabs.forEach((tab) => {
          if(tab.id){
            setBadgeWhitelist(tab.id)
            tabUpdateScriptState(tab.id, 'disable')
          }
        }))
      }else if (msg.mode === 'del') {
        updateLocalWhitelist('del', msg.host)
        selectTabByHost(msg.host).then((tabs) => tabs.forEach((tab) => {
          if(tab.id){
            remBadge(tab.id)
            tabUpdateScriptState(tab.id, 'enable')
          }
        }))
      }
      break
    }
  }
})

/**
 * 监听tab变化
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url) return
  if (changeInfo.status === 'loading') {
    const host = urlToHttpHost(tab.url)
    if (!host) return
    if (localStorage?.whitelist.has(host)) {
      setBadgeWhitelist(tabId)
    }
  }
});