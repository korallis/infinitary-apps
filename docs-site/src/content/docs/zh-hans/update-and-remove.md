---
source: 8949d6275dea6548
title: 更新和移除 Infinitary
description: 每种安装方式如何获得新的稳定版，以及如何移除 Infinitary 并保留你已保存的工作。
---

Infinitary 每隔几个小时检查一次是否有新的稳定版。
检查不会下载任何东西，在你选择之前也不会安装任何东西。
更新会保留你已保存的工作。

## 新版本发布时 {#when-a-new-version-is-out}

窗口右上角会出现一个带向下箭头的圆形按钮。
把指针停在它上面，可以读到“有可用更新”和新版本的编号，点击它可以看到接下来该怎么做。
设置 → **通用** 在 **版本** 下显示同样的内容。

想自己检查的话，可以用下面任意一种方式：

- 设置 → **通用** 中 **版本** 下的 **检查更新**。
- 命令搜索中的 **检查更新**。
- 在 Mac 上，Infinitary 菜单中的 **检查更新…**。

接下来该做什么，取决于你是怎么安装 Infinitary 的。

## 从下载页面获得的 Mac 版本 {#a-mac-copy-from-the-downloads-page}

1. 点击 **更新并重启**。
2. Infinitary 下载新版本，并检查它的校验和与 Apple 签名。
3. 它会保存你的船员的工作。
   正在运行的工作会先完成手头在做的事，所以不会丢失任何东西。
4. Infinitary 以新版本重新启动，并恢复更新期间暂停的工作。

在它等待正在运行的工作期间，**稍后更新** 会先搁置这次更新，直到你再次选择它。
你的工作继续进行。

如果 Infinitary 没能完成重启，按钮会显示 **重启**。
等你正在运行的工作停下后，再点击一次。

Infinitary 只会在“应用程序”文件夹中自行更新。
如果它是从磁盘映像运行的，请把它拖进“应用程序”，推出磁盘映像，然后打开“应用程序”中的那一份。

## 从 Homebrew 获得的 Mac 版本 {#a-mac-copy-from-homebrew}

用 Homebrew 安装的版本通过 Homebrew 更新。
通知中会显示命令，并带有 **复制命令**：

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

在“终端”中运行它。
Homebrew 在替换 Infinitary 时会退出它，所以完成后请再次打开 Infinitary。

## Linux {#linux}

- **Ubuntu、Debian 和 Fedora**，使用 .deb 或 .rpm 软件包：点击 **安装**。
  Infinitary 会下载新版本，检查它，保存你的船员的工作并请求你的密码，然后重新启动。
- **AppImage**：点击 **安装**。
  Infinitary 会用新版本替换 AppImage 文件并重新启动，不需要密码。
  它需要能够修改 AppImage 所在的文件夹。
- **Arch、Omarchy 和 NixOS** 通过各自的软件包管理器更新。
  通知中会显示命令，并带有 **复制命令**；请在终端中运行它。

如果安装无法完成，什么都不会改变，你的船员的工作会继续进行。
通知随后会显示一条命令，可以手动安装同一个版本。

## Windows {#windows}

1. 点击 **更新并重启**。
2. Infinitary 下载新的安装程序，检查它的校验和，并保存船员的工作。
3. Infinitary 关闭，安装程序替换它，然后新版本的 Infinitary 再次打开。

如果安装无法完成，什么都不会改变，船员的工作会继续进行。

## 你的其他电脑和你的手机 {#your-other-computers-and-your-phone}

你添加的电脑会从大副所在的电脑更新。
在设置 → **设备** 中，版本不同的电脑那一行会显示 **更新**。
它会获得这台电脑的版本，它正在运行的工作会停一小会儿，之后继续。

在控制你的大副的电脑上，设置 → **通用** 有一行对应大副所在电脑上的 Infinitary。
当那台电脑有更新准备好时，点击 **更新** 加上它的名称，就能在你所在的地方开始更新。
你的手机也可以开始那次更新，在它先询问你之后。
请参阅[你的其他电脑](/zh-hans/your-other-computers/)和 [iPhone 和 iPad](/zh-hans/iphone-and-ipad/)。

## 移除 Infinitary {#remove-infinitary}

移除应用不会动你已保存的工作，所以再次安装 Infinitary 后，会从你离开的地方继续。
如果这台电脑为另一台电脑运行工作，请先在设置 → **设备** 中点击 **离开**。

- **从下载页面获得的 Mac 版本**：退出 Infinitary，把它从“应用程序”移到废纸篓。
- **从 Homebrew 获得的 Mac 版本**：在“终端”中运行 `brew uninstall --cask infinitary`。
  千万不要加 `--zap`：它会删除你已保存的工作。
- **Linux**：用你安装它时所用的软件安装器或软件包管理器移除软件包。
  如果是 AppImage，删除这个文件即可。
- **Windows**：在 Windows 设置 → **应用** → **已安装的应用** 中，从 Infinitary 的菜单里选择 **卸载**。

你已保存的工作留在 Mac 上的 `~/Library/Application Support/infinitary` 中，Linux 上的 `~/.config/infinitary` 中，以及 Windows 上的 `%APPDATA%\infinitary` 中。

### 什么会删除你已保存的工作 {#what-deletes-your-saved-work}

这些操作会删除那个文件夹，Infinitary 保存在其中的内容也会随之消失：

- `brew uninstall --zap`。
- 同时移除应用支持文件的卸载工具。
- 把这个文件夹本身移到废纸篓，或者删除它。

在一台为另一台电脑运行工作的电脑上，那个文件夹存放着这台电脑自己的密钥、它的工作副本和它的任务文件。
没有了它，这台电脑会作为一个新条目重新加入，它还没带回的工作就此丢失。
请参阅[一台电脑出现了两次](/zh-hans/troubleshooting/#a-computer-is-listed-twice)。
