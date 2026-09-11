# 4. 批量部署

一个任务 = 「往哪些机器、上传哪些文件、跑什么命令」，写在一个 JSON 文件里。

[**新建部署任务**](command:bastion.addDeployTask)

```jsonc
{
  "name": "部署配置",
  "profile": "生产",
  "hosts": ["10.0.0.1", "10.0.0.2"],
  "uploads": ["D:/work/config.yaml"],
  "preCommand": ["sudo -i", "cd /etc"],
  "script": ["systemctl restart nginx"],
  "userChoice": "1"
}
```

## 跑起来之后

- 侧边栏「部署任务」里，行内 ▶ 就是执行；**单击任务是打开文件编辑**（跑部署不该是手滑就能触发的）
- 底栏显示 `部署 3/8`，随时可以停（停在「跑完当前这台」，不会把目标机留在半执行状态）
- 跑完生成报告：**每条命令 + 它的实际输出**，失败的会自动打开报告

[**批量执行任务**](command:bastion.batchRunDeployTasks)

## 相关设置

- `bastion.deployTerminalPolicy`：跑完要不要保留终端窗口（底栏也有个一键开关）
- 任务里可以写 `"keepTerminal": true` 单独给这个任务开（不写就跟随全局）
