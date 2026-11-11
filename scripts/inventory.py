#!/usr/bin/env python3
"""盘点原 PHP 仓库的路由、插件、表和可读性，不连接数据库，也不运行 PHP。

调用：python3 scripts/inventory.py
指定源：python3 scripts/inventory.py --source reference/ZJMF-CBAP --output /tmp/inventory.json
生成文件是待迁移清单，任何条目都不会仅凭扫描被标成已完成。
"""
from __future__ import annotations  # 类型说明不会触发仓库内的代码

import argparse  # 接收源码位置和输出文件
import collections  # 汇总同类功能的数量
import hashlib  # 固定被检查文件的内容
import json  # 生成可被后续验收程序读取的清单
import re  # 提取 PHP 静态声明
import subprocess  # 只读取 Git 提交号
from pathlib import Path  # 按脚本位置找到项目，避免启动位置影响结果

PROJECT = Path(__file__).resolve().parent.parent  # 项目位置只有一个来源
STRINGS = r"(?:'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\")"  # 路由里的引号内容允许转义


def mask_comments(text: str, *, strings: bool = False) -> str:
    """遮住 PHP 注释；保留换行和字符位置，便于给每个证据标行号。

    strings=True 时也遮住字符串，用于寻找成对的大括号。
    """
    pattern = STRINGS + r"|/\*[\s\S]*?\*/|//[^\n]*|\#[^\n]*"  # 引号先匹配，避免把 URL 当注释
    def replace(match: re.Match) -> str:
        value = match.group()  # 每次只处理一个完整的引号或注释
        if value.startswith(("'", '"')) and not strings:  # 读取参数时保留原来的字符串
            return value
        return re.sub(r"[^\n]", " ", value)  # 不改变证据的行数和偏移
    return re.sub(pattern, replace, text)


def expression(value: str) -> str:
    """将简单 PHP 路径表达式转成可读路径；动态变量保留 ${...} 标记。"""
    parts = re.findall(STRINGS + r"|\$?[A-Za-z_][A-Za-z0-9_]*", value)  # 按拼接顺序取出各段
    result = []  # 不执行 PHP，只解释字符串和常量
    for part in parts:
        if part.startswith(("'", '"')):  # 引号包着的部分就是静态路径
            result.append(part[1:-1].replace("\\'", "'").replace('\\"', '"'))
        else:
            result.append("${" + part.lstrip("$") + "}")  # 部署时才确定的前缀必须保持可见
    return "".join(result)


def routes(path: Path, source: Path) -> list[dict]:
    """抽取一个路由文件的声明和嵌套分组；返回路径、方法、目标和证据行。"""
    original = path.read_text(encoding="utf-8-sig", errors="replace")  # 原文件只读，不加载配置
    clean = mask_comments(original)  # 注释掉的旧接口不算有效声明
    braces = mask_comments(original, strings=True)  # 引号中的大括号不参与分组配对
    groups = []  # 每组记录开始位置、结束位置和路径前缀
    for match in re.finditer(r"Route::group\(\s*([^,]+),\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{", clean):
        start = match.end() - 1  # 从回调的左大括号开始配对
        depth = 1  # 允许后台路由里再套权限分组
        end = start + 1  # 向后找到当前回调真正的结束处
        while depth and end < len(braces):
            depth += (braces[end] == "{") - (braces[end] == "}")  # 只数代码里的大括号
            end += 1  # 下一个字符仍保持原文件偏移
        groups.append((start, end, expression(match.group(1))))  # 空前缀也保留嵌套关系
    declarations = []  # 逐个保留方法和目标，重复声明也不静默删除
    pattern = r"Route::(get|post|put|delete|patch|head|options|any|rule)\(\s*(" + STRINGS + r"|[^,\n]+)\s*,\s*(" + STRINGS + r")"
    for match in re.finditer(pattern, clean, re.I):
        prefixes = [prefix for start, end, prefix in groups if start < match.start() < end]  # 外层前缀在前
        full_path = "/" + "/".join(item.strip("/") for item in [*prefixes, expression(match.group(2))] if item.strip("/"))  # 合成可核对路径
        line = original.count("\n", 0, match.start()) + 1  # 行号指向声明本身
        declarations.append({"method": match.group(1).upper(), "path": full_path,
                             "target": expression(match.group(3)), "file": str(path.relative_to(source)),
                             "line": line, "status": "pending", "replacement": None, "acceptance": []})  # 没有实现证据就不能算完成
    return declarations


def plugins(version: Path, source: Path) -> list[dict]:
    """列出仓库实际提供的每个插件；不推断应用商店里有哪些收费版本。"""
    result = []  # 目录存在才能进入迁移范围
    base = version / "public/plugins"  # 插件位置来自原版约定
    for category in sorted(base.iterdir()):
        if not category.is_dir():  # 文件不是插件分类
            continue
        for folder in sorted(category.iterdir()):
            if not folder.is_dir():  # 图片和说明文件不单独当插件
                continue
            result.append({"category": category.name, "name": folder.name,
                           "path": str(folder.relative_to(source)),
                           "phpFiles": sum(1 for _ in folder.rglob("*.php")),
                           "routeFile": str((folder / "route.php").relative_to(source)) if (folder / "route.php").is_file() else None,
                           "status": "pending"})  # 源文件存在不等于新版本已经实现
    return result


def tables(version: Path, source: Path) -> list[dict]:
    """只抽取安装 SQL 的结构，不输出安装包里的账户、密钥或示例数据。"""
    path = version / "public/install/idcsmart.sql"  # 此文件给出初始表结构
    text = path.read_text(encoding="utf-8-sig", errors="replace")  # 不把 SQL 送入数据库
    result = []  # 升级脚本可能还有变更，文档中保留这一限制
    for match in re.finditer(r"CREATE\s+TABLE\s+`([^`]+)`\s*\(([\s\S]*?)\)\s*ENGINE", text, re.I):
        columns = re.findall(r"^\s*`([^`]+)`\s+([^\n]+)", match.group(2), re.M)  # 只取列名和定义
        result.append({"name": match.group(1), "columns": [{"name": name, "definition": definition.rstrip(",")} for name, definition in columns],
                       "file": str(path.relative_to(source)), "line": text.count("\n", 0, match.start()) + 1,
                       "status": "pending"})  # 导入和对账验证完成前一直待迁移
    return result


def readability(version: Path, source: Path) -> dict:
    """寻找编码器标记和运行时依赖；普通 base64 处理不当成加密源码。"""
    encoded = []  # 只记录具体命中，不从应用商店要求猜测源码加密
    dependencies = []  # 安装器要求 Loader 与文件已加密是两件事
    files = [*version.joinpath("app").rglob("*.php"), *version.joinpath("public/plugins").rglob("*.php")]  # 不检查框架 vendor
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")  # 扫描没有执行风险
        if re.search(r"ioncube_loader|__halt_compiler\s*\(|zend_loader_file_encoded|sg_load\s*\(", text, re.I):
            encoded.append(str(path.relative_to(source)))  # 命中需要人工确认，不能直接声称破解或可迁移
        if re.search(r"extension_loaded\(['\"]ionCube Loader", text, re.I):
            dependencies.append(str(path.relative_to(source)))  # 源码可读但商店安装流程检查 Loader
    return {"encodedPhpCandidates": encoded, "ioncubeRuntimeDependencies": dependencies,
            "scope": "app/**/*.php 和 public/plugins/**/*.php；静态标记扫描不能证明不存在其他混淆"}


def build(source: Path) -> dict:
    """生成可重复的原版清单；每条证据固定到来源提交和原始文件。"""
    version = source / "10.4.6"  # 此次任务只针对用户指定仓库内的版本
    core_files = sorted(version.joinpath("route").glob("*.php"))  # 三个核心路由文件
    plugin_files = sorted(version.joinpath("public/plugins").glob("*/*/route.php"))  # 只扫描插件约定入口
    core_routes = [route for path in core_files for route in routes(path, source)]  # 核心声明单独计数
    plugin_routes = [route for path in plugin_files for route in routes(path, source)]  # 插件声明保留所属路径
    plugin_list = plugins(version, source)  # 逐个插件保留真实名称
    table_list = tables(version, source)  # 表结构供导入映射使用
    commit = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()  # 固定源码提交
    return {"repository": "https://github.com/idcsmart/ZJMF-CBAP", "commit": commit, "version": "10.4.6", "license": "AGPL-3.0",
            "limitations": ["只抽取静态 Route 声明；动态插件默认控制器路由不包含在声明数量内", "安装 SQL 不是线上数据库；升级脚本和实际数据库需单独比对", "所有 status 默认 pending，需用新实现与验收证据逐项更新", "路径中的 ${DIR_ADMIN} 保留原版部署时后台前缀，不替换成猜测值"],
            "summary": {"coreRoutes": len(core_routes), "pluginRoutes": len(plugin_routes), "routeFiles": len(core_files) + len(plugin_files),
                        "coreRoutesByFile": dict(collections.Counter(route["file"] for route in core_routes)),
                        "plugins": len(plugin_list), "pluginsByCategory": dict(collections.Counter(plugin["category"] for plugin in plugin_list)), "installTables": len(table_list)},
            "sourceFiles": [{"path": str(path.relative_to(source)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in [*core_files, *plugin_files]],
            "coreRoutes": core_routes, "pluginRoutes": plugin_routes, "plugins": plugin_list, "tables": table_list, "readability": readability(version, source),
            "requestedPaymentAvailability": {"wechat": "public/plugins/gateway/wx_pay", "alipay": "public/plugins/gateway/ali_pay_dmf", "epay": None, "hupijiao": None}}


def main() -> None:
    """处理本地输入并写清单；调用示例：python3 scripts/inventory.py。"""
    parser = argparse.ArgumentParser(description=__doc__)  # 错误路径交给命令行边界报错
    parser.add_argument("--source", type=Path, default=PROJECT / "reference/ZJMF-CBAP")  # 默认路径不依赖当前目录
    parser.add_argument("--output", type=Path, default=PROJECT / "reference/inventory.json")  # 输出位置可供干跑覆盖
    arguments = parser.parse_args()  # 外部参数只在入口读取
    inventory = build(arguments.source.resolve())  # 读取证据，绝不连接线上系统
    arguments.output.parent.mkdir(parents=True, exist_ok=True)  # 输出目录不存在时先建目录
    arguments.output.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")  # 便于代码审查的稳定格式
    print(json.dumps(inventory["summary"], ensure_ascii=False, indent=2))  # 终端只显示数量，不输出配置或安装数据


if __name__ == "__main__":  # import 本脚本不会自动写文件
    main()  # 执行唯一命令入口
