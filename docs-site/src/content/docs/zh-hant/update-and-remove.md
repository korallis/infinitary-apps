---
source: 8949d6275dea6548
title: 更新與移除 Infinitary
description: 每種安裝方式如何取得新的穩定版，以及如何移除 Infinitary 並保留你保存的工作。
---

Infinitary 每隔幾小時會檢查一次有沒有新的穩定版。
檢查時不會下載任何東西，在你選擇之前也不會安裝任何東西。
更新會保留你保存的工作。

## 有新版本時 {#when-a-new-version-is-out}

視窗右上角會出現一個帶向下箭頭的圓形按鈕。
把指標停在上面，會看到「有可用的更新」和新版本的版本號；按下它，就能看到接下來要做什麼。
設定 → **一般** 的 **版本** 底下也會顯示同樣的內容。

想自己檢查，可以用以下任何一種方式：

- 設定 → **一般** 裡 **版本** 底下的 **檢查更新**。
- 指令搜尋裡的 **檢查更新**。
- 在 Mac 上，Infinitary 選單裡的 **檢查更新…**。

接下來要做什麼，取決於你當初怎麼安裝 Infinitary。

## 從下載頁面安裝的 Mac 版 {#a-mac-copy-from-the-downloads-page}

1. 按 **更新並重新啟動**。
2. Infinitary 會下載新版本，並檢查它的總和檢查碼和 Apple 簽章。
3. 它會保存船員的工作。
   正在執行的工作會先完成手上的事，所以什麼都不會遺失。
4. Infinitary 會以新版本重新啟動，並繼續更新時暫停的工作。

在它等待執行中的工作時，**稍後更新** 會讓這次更新先擱著，等你再次選擇它。
你的工作會照常進行。

如果 Infinitary 沒能完成重新啟動，按鈕會顯示 **重新啟動**。
等執行中的工作停下來後，再按一次。

Infinitary 只有在「應用程式」裡才會自行更新。
如果它是從磁碟映像檔執行的，請把它拖進「應用程式」，退出磁碟映像檔，再打開「應用程式」裡的那一份。

## 用 Homebrew 安裝的 Mac 版 {#a-mac-copy-from-homebrew}

用 Homebrew 安裝的 Infinitary 會透過 Homebrew 更新。
通知會顯示指令，並附上 **複製指令**：

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

在「終端機」裡執行它。
Homebrew 替換 Infinitary 時會先結束它，所以完成後請再打開 Infinitary。

## Linux {#linux}

- **Ubuntu、Debian 和 Fedora**，用 .deb 或 .rpm 套件安裝的：按 **安裝**。
  Infinitary 會下載新版本、檢查它、保存船員的工作並要求你輸入密碼，然後重新啟動。
- **AppImage**：按 **安裝**。
  Infinitary 會用新版本取代 AppImage 檔案並重新啟動，不需要密碼。
  它需要能更動 AppImage 所在的資料夾。
- **Arch、Omarchy 和 NixOS** 透過它們自己的套件管理工具更新。
  通知會顯示指令，並附上 **複製指令**；請在終端機裡執行它。

如果安裝沒辦法完成，什麼都不會改變，船員的工作也會照常進行。
這時通知會顯示一個能手動安裝同一版本的指令。

## Windows {#windows}

1. 按 **更新並重新啟動**。
2. Infinitary 會下載新的安裝程式，檢查它的總和檢查碼，並保存船員的工作。
3. Infinitary 會關閉，由安裝程式替換它，接著新版本的 Infinitary 會再次打開。

如果安裝無法完成，什麼都不會改變，船員的工作也會繼續進行。

## 你的其他電腦和手機 {#your-other-computers-and-your-phone}

你加入的電腦，會從大副所在的電腦取得更新。
在設定 → **裝置** 裡，版本不同的電腦，它那一列會顯示 **更新**。
它會取得這台電腦的版本，執行中的工作會暫停片刻，之後再繼續。

在控制大副的電腦上，設定 → **一般** 有一列是大副所在電腦上的 Infinitary。
當那台電腦有更新可以安裝時，按 **更新** 加上它的名稱，就能從你所在的地方開始更新。
你的手機也能開始這項更新，它會先問過你。
請看 [你的其他電腦](/zh-hant/your-other-computers/) 和 [iPhone 和 iPad](/zh-hant/iphone-and-ipad/)。

## 移除 Infinitary {#remove-infinitary}

移除程式後，你保存的工作會留在原處，所以再次安裝 Infinitary 時，可以從上次停下的地方繼續。
如果這台電腦正在替另一台電腦執行工作，請先在設定 → **裝置** 裡按 **退出**。

- **從下載頁面安裝的 Mac 版**：結束 Infinitary，把它從「應用程式」移到垃圾桶。
- **用 Homebrew 安裝的 Mac 版**：在「終端機」裡執行 `brew uninstall --cask infinitary`。
  千萬不要加上 `--zap`：它會刪除你保存的工作。
- **Linux**：用你當初安裝它的軟體安裝工具或套件管理工具移除套件。
  如果是 AppImage，刪除檔案即可。
- **Windows**：在 Windows 設定 → **應用程式** → **已安裝的應用程式** 中，從 Infinitary 的選單選擇 **解除安裝**。

你保存的工作在 Mac 上位於 `~/Library/Application Support/infinitary`，在 Linux 上位於 `~/.config/infinitary`，在 Windows 上位於 `%APPDATA%\infinitary`。

### 哪些情況會刪除你保存的工作 {#what-deletes-your-saved-work}

以下這些會刪除那個資料夾，Infinitary 存放在那裡的東西也會一起消失：

- `brew uninstall --zap`。
- 也會移除 App 支援檔案的解除安裝 App。
- 把資料夾本身移到垃圾桶，或刪除它。

在替另一台電腦執行工作的電腦上，那個資料夾存放著這台電腦自己的金鑰、它的工作副本和它的任務檔案。
少了它，這台電腦再次加入時會成為一個新的項目，它還沒帶回去的工作就會遺失。
請看 [同一台電腦列出了兩次](/zh-hant/troubleshooting/#a-computer-is-listed-twice)。
