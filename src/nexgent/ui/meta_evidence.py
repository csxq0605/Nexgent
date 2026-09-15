"""Read-only projections of persisted improver probes and held-out comparisons."""

from copy import deepcopy
import html
import math

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView, QHeaderView, QLabel, QPushButton, QSplitter,
    QTableWidget, QTableWidgetItem, QTextBrowser, QVBoxLayout, QWidget,
)


def _esc(value):
    return html.escape(str(value))


def _number(value, signed=False):
    if type(value) not in (int, float) or not math.isfinite(value):
        return "缺测"
    return f"{value:+.4f}" if signed else f"{value:.4f}"


STATE = {"started": "进行中", "completed": "已完成", "complete": "完整",
         "incomplete": "证据不完整", "failed": "执行失败", "interrupted": "已中断",
         "skipped_identical_improver": "改进器相同，未执行探测"}


class MetaEvidencePanel(QWidget):
    """No controller or execution capabilities: rendering cannot start research."""

    def __init__(self, show_details, parent=None):
        super().__init__(parent)
        self.show_details = show_details
        self.records = []
        self.report = None
        layout = QVBoxLayout(self); layout.setContentsMargins(0, 12, 0, 0)
        self.summary = QLabel(); self.summary.setWordWrap(True); layout.addWidget(self.summary)
        split = QSplitter(Qt.Orientation.Vertical); layout.addWidget(split, 1)
        probe_page = QWidget(); probe_layout = QVBoxLayout(probe_page); probe_layout.setContentsMargins(0, 0, 0, 0)
        probe_layout.addWidget(QLabel("开发集改进器探测 · 可用于后续研究，不能充当独立确认"))
        self.probes = self._table(["实验", "状态", "初始增益", "候选增益", "配对差值", "模型调用"])
        probe_layout.addWidget(self.probes)
        self.probe_detail = QTextBrowser(); self.probe_detail.setOpenExternalLinks(False)
        probe_layout.addWidget(self.probe_detail); split.addWidget(probe_page)
        self.probes.itemSelectionChanged.connect(self._probe_selected)
        self.probes.cellDoubleClicked.connect(lambda row, col: self._open_probe(row))
        comparison_page = QWidget(); comparison_layout = QVBoxLayout(comparison_page); comparison_layout.setContentsMargins(0, 6, 0, 0)
        self.comparison_summary = QTextBrowser(); comparison_layout.addWidget(self.comparison_summary)
        self.pairs = self._table(["独立种子", "初始改进器收益", "演化改进器收益", "配对差值", "完整性"])
        comparison_layout.addWidget(self.pairs)
        self.pairs.cellDoubleClicked.connect(lambda row, col: self._open_pair(row))
        self.details_button = QPushButton("查看完整独立对照记录")
        self.details_button.clicked.connect(lambda: self.show_details("独立改进器对照", self.report))
        comparison_layout.addWidget(self.details_button); split.addWidget(comparison_page)
        split.setSizes([310, 310])

    @staticmethod
    def _table(headers):
        table = QTableWidget(0, len(headers)); table.setHorizontalHeaderLabels(headers)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        table.verticalHeader().hide()
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        table.horizontalHeader().setSectionResizeMode(len(headers) - 1, QHeaderView.ResizeMode.Stretch)
        return table

    @staticmethod
    def _fill(table, rows):
        table.setRowCount(len(rows))
        for row, (values, payload) in enumerate(rows):
            for col, value in enumerate(values):
                item = QTableWidgetItem(str(value)); item.setToolTip(str(value))
                if col == 0: item.setData(Qt.ItemDataRole.UserRole, deepcopy(payload))
                table.setItem(row, col, item)

    @staticmethod
    def _probe_records(state):
        # A started and terminal event describe one RPC, not two experiments.
        by_id = {}
        for index, event in enumerate(state.get("events") or []):
            if not isinstance(event, dict): continue
            content = event.get("content")
            if event.get("kind") != "capability" or not isinstance(content, dict) or content.get("method") != "probe_improver":
                continue
            identity = content.get("id") or f"event-{event.get('sequence', index)}"
            previous = by_id.get(identity, {})
            if previous.get("status") in {"completed", "failed", "interrupted"} and content.get("status") == "started":
                continue
            by_id[identity] = {**previous, **deepcopy(content)}
        return list(by_id.values())

    def render(self, state):
        previous = self.probes.item(self.probes.currentRow(), 0)
        selected_id = (previous.data(Qt.ItemDataRole.UserRole) or {}).get("id") if previous else None
        self.records = self._probe_records(state)
        conclusion = state.get("conclusion") or {}
        changed = conclusion.get("executable_meta_changed")
        mutation = "存在改进器或编排修改" if changed is True else "未记录改进器或编排修改" if changed is False else "改进器源码变化尚无结论"
        inherited = conclusion.get("inherited_improver_executed")
        inherited_text = f"；{len(inherited)} 个修改后的改进器有继承执行记录" if isinstance(inherited, list) else ""
        self.summary.setText(mutation + inherited_text + "。源码变化、开发探测与独立后代效能分别核对。")
        if state.get("kind") == "benchmark_evaluation":
            self.summary.setText("本记录只评价固定任务程序，未运行改进器；不能作为自改进效果的证据。")
        rows = []
        for record in self.records:
            result = record.get("result") or {}; request = record.get("request") or {}
            arms = {a.get("arm"): a for a in result.get("arms", []) if isinstance(a, dict)}
            status = result.get("status", record.get("status", "未记录"))
            costs = result.get("costs") or {}
            calls = costs.get("model_calls_with_identity")
            rows.append(([result.get("label", request.get("label", record.get("id", "探测"))),
                STATE.get(status, status), _number(arms.get("initial", {}).get("development_gain"), True),
                _number(arms.get("evolved", {}).get("development_gain"), True),
                _number((result.get("aggregate") or {}).get("paired_development_gain"), True),
                calls if calls is not None else "未记录"], record))
        self.probes.blockSignals(True); self._fill(self.probes, rows); self.probes.blockSignals(False)
        if rows:
            row = next((i for i, record in enumerate(self.records) if record.get("id") == selected_id), 0)
            self.probes.selectRow(row); self._probe_selected()
        else:
            self.probe_detail.setPlainText("尚未记录实际改进器探测。窗口不会自动运行探测；没有结果不能解释为零收益。")
        self.report = state.get("meta_evaluation") or conclusion.get("meta_evaluation")
        if not isinstance(self.report, dict): self.report = None
        self.details_button.setEnabled(self.report is not None)
        if self.report is None:
            self.pairs.setRowCount(0)
            status = state.get("status")
            message = ("独立后代对照正在执行，尚无完整报告。" if status == "running" else
                "独立后代对照未完成；查看研究事件和保留的错误，缺测不计为零。") if state.get("kind") == "meta_evaluation" else "尚未记录独立后代对照。开发探测不能替代未见任务上的确认。"
            self.comparison_summary.setHtml("<h3>独立后代效能</h3><p>" + message + "</p>")
            return
        report = self.report; evidence = report.get("evidence") or {}; costs = report.get("costs") or {}
        protocol = report.get("protocol") or {}; pairs = report.get("per_seed_pairs") or []
        aggregate = report.get("aggregate") or {}
        paired = aggregate.get("paired_difference") or {}
        pieces = ["<h3>独立后代效能</h3>",
            f"<p>完整配对 {_esc(evidence.get('complete_pairs', '未记录'))} / {_esc(evidence.get('requested_pairs', '未记录'))}；每臂后代上限 k={_esc(protocol.get('k', '未记录'))}；独立配对平均差值 {_number(paired.get('mean'), True)}。</p>",
            f"<p>证据等级：{_esc(evidence.get('level', '未记录'))}。模型调用 {_esc(costs.get('model_calls_with_identity', '未记录'))}；已报告 Token {_esc((costs.get('known_usage') or {}).get('total_tokens', '未记录'))}；用量缺失请求 {_esc(len(costs['usage_missing_call_ids']) if isinstance(costs.get('usage_missing_call_ids'), list) else '未记录')}。</p>",
            "<p>比较的是冻结改进器从共同任务起点产生后代的效能；流程完成或正差值本身不代表递归改进已成立。</p>"]
        if evidence.get("missing"): pieces.append(f"<p>缺少 {len(evidence['missing'])} 项执行或成本证据，详见完整记录。</p>")
        if report.get("failures"): pieces.append(f"<p>保留 {len(report['failures'])} 项失败，未用零分补齐。</p>")
        self.comparison_summary.setHtml("".join(pieces))
        self._fill(self.pairs, [([row.get("seed", "未记录"), _number(row.get("initial_improvement_at_k"), True),
            _number(row.get("evolved_improvement_at_k"), True), _number(row.get("difference"), True),
            STATE.get(row.get("status"), row.get("status", "未记录"))], row) for row in pairs if isinstance(row, dict)])

    def _probe_selected(self):
        item = self.probes.item(self.probes.currentRow(), 0)
        if not item: return
        record = item.data(Qt.ItemDataRole.UserRole); result = record.get("result") or {}
        status = result.get("status", record.get("status", "未记录"))
        pieces = [f"<h3>{_esc(STATE.get(status, status))}</h3>",
            "<p>开发数据内的真实改进器试验；不读取独立迁移评价。双击实验行查看完整工件与执行记录。</p>",
            f"<p>请求来源：{_esc(record.get('source_bundle', '未记录'))}<br>探测编号：{_esc(result.get('probe_id', record.get('id', '未记录')))}</p>"]
        for key, label in (("source_reference", "参考改进器"), ("source_candidate", "候选改进器"), ("task_anchor", "共同任务起点")):
            source = result.get(key) or {}
            if source: pieces.append(f"<p>{label}：{_esc(source.get('id', '未记录'))}<br>{_esc(source.get('digest', '未记录'))}</p>")
        if record.get("error_type"): pieces.append(f"<p>失败类型：{_esc(record['error_type'])}</p>")
        self.probe_detail.setHtml("".join(pieces))

    def _open_probe(self, row):
        item = self.probes.item(row, 0)
        if item: self.show_details("开发改进器探测证据", item.data(Qt.ItemDataRole.UserRole))

    def _open_pair(self, row):
        item = self.pairs.item(row, 0)
        if item: self.show_details("独立种子配对证据", item.data(Qt.ItemDataRole.UserRole))
