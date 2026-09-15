"""Read-only projections of persisted improver probes and held-out comparisons."""

from copy import deepcopy
import html
import math

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QAbstractItemView, QComboBox, QHBoxLayout, QHeaderView, QLabel, QPushButton, QSplitter,
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

    refresh_requested = pyqtSignal()

    def __init__(self, show_details, parent=None):
        super().__init__(parent)
        self.show_details = show_details
        self.records = []
        self.report = None
        self._comparison_rows = []
        self._study_id = None
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
        choices = QHBoxLayout()
        choices.addWidget(QLabel("已完成的独立对照"))
        self.comparison_choice = QComboBox(); choices.addWidget(self.comparison_choice, 1)
        self.refresh_reports = QPushButton("刷新对照记录"); choices.addWidget(self.refresh_reports)
        self.refresh_reports.clicked.connect(self.refresh_requested.emit)
        comparison_layout.addLayout(choices)
        self.report_context = QLabel(); self.report_context.setWordWrap(True)
        self.report_context.setTextFormat(Qt.TextFormat.PlainText)
        self.report_context.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        comparison_layout.addWidget(self.report_context)
        self.related_summary = QLabel(); self.related_summary.setWordWrap(True)
        comparison_layout.addWidget(self.related_summary)
        self.comparison_summary = QTextBrowser(); comparison_layout.addWidget(self.comparison_summary)
        self.pairs = self._table(["独立种子", "初始改进器收益", "演化改进器收益", "配对差值", "完整性"])
        comparison_layout.addWidget(self.pairs)
        self.pairs.cellDoubleClicked.connect(lambda row, col: self._open_pair(row))
        self.details_button = QPushButton("查看完整独立对照记录")
        self.details_button.clicked.connect(lambda: self.show_details("独立改进器对照", self.report))
        self.comparison_choice.currentIndexChanged.connect(self._comparison_selected)
        comparison_layout.addWidget(self.details_button); split.addWidget(comparison_page)
        split.setSizes([220, 440])

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

    @staticmethod
    def _comparisons(state, related_studies):
        """Join only persisted origin links; the legacy attached report is a fallback."""
        independent = state.get("kind") == "meta_evaluation"
        studies = [state] if independent else [row for row in related_studies
            if row.get("kind") == "meta_evaluation" and row.get("status") == "completed"
            and (row.get("registration") or {}).get("origin_study") == state.get("id")]
        records = {}
        for study in studies:
            report = study.get("meta_evaluation")
            if not isinstance(report, dict): continue
            registration = study.get("registration") or {}
            identity = report.get("meta_study_id") or study.get("id")
            records[identity] = {"id": identity, "report": deepcopy(report),
                "registration": deepcopy(registration), "benchmark": study.get("benchmark") or {},
                "origin": registration.get("origin_study")}
        legacy = state.get("meta_evaluation") or (state.get("conclusion") or {}).get("meta_evaluation")
        if isinstance(legacy, dict):
            identity = legacy.get("meta_study_id") or (state.get("id") if independent else "legacy:" + str(state.get("id")))
            records.setdefault(identity, {"id": identity, "report": deepcopy(legacy),
                "registration": deepcopy(state.get("registration") or {}) if independent else {},
                "benchmark": state.get("benchmark") or {} if independent else {},
                "origin": (state.get("registration") or {}).get("origin_study") if independent else state.get("id")})
        source_domain = (state.get("benchmark") or {}).get("id")
        return sorted(records.values(), key=lambda row: (
            (row["report"].get("benchmark") or row["benchmark"]).get("id") != source_domain, str(row["id"])))

    @staticmethod
    def _identity_text(row):
        report = row.get("report") or {}; registration = row.get("registration") or {}
        benchmark = report.get("benchmark") or row.get("benchmark") or registration.get("benchmark") or {}
        protocol = report.get("protocol") or {}
        cross = report.get("cross_benchmark", registration.get("cross_benchmark"))
        transfer = "跨基准迁移对照" if cross is True else "同基准对照" if cross is False else "跨基准关系未记录"
        identity = row.get("id") or "未记录"
        if str(identity).startswith("legacy:"): identity = "旧报告未提供独立研究 ID"
        seeds = protocol.get("seeds", registration.get("seeds"))
        seed_text = ", ".join(str(seed) for seed in seeds) if isinstance(seeds, list) else "未记录"
        return (f"目标基准：{benchmark.get('title', '名称未记录')} [{benchmark.get('id', 'ID 未记录')}] · {transfer}\n"
            f"独立研究：{identity} · 来源研究：{row.get('origin') or '未记录'}\n"
            f"种子：{seed_text} · 每臂后代上限 k={protocol.get('k', registration.get('k', '未记录'))}")

    @staticmethod
    def _offspring_counts(report):
        arms = report.get("arms")
        if not isinstance(arms, list): return None
        counts = {"generated": 0, "evaluated": 0, "initial": 0, "evolved": 0}
        for arm in arms:
            if not isinstance(arm, dict) or not isinstance(arm.get("attempts"), list): return None
            for attempt in arm["attempts"]:
                candidates = attempt.get("candidates")
                if not isinstance(candidates, list): return None
                counts["generated"] += len(candidates)
                counts["evaluated"] += sum(c.get("status") == "evaluated" for c in candidates if isinstance(c, dict))
                if arm.get("arm") in ("initial", "evolved"):
                    counts[arm["arm"]] += len(candidates)
        return counts

    def render(self, state, related_studies=()):
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
        elif state.get("kind") == "meta_evaluation":
            self.summary.setText("独立改进器对照 · 只读记录。比较冻结程序产生任务后代的效能，不会继续自改进或重发请求。")
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
        selected = self.comparison_choice.currentData() if self._study_id == state.get("id") else None
        self._study_id = state.get("id")
        self._comparison_rows = self._comparisons(state, related_studies)
        counts = [self._offspring_counts(row["report"]) for row in self._comparison_rows]
        if counts and all(value is not None for value in counts):
            self.related_summary.setText(f"关联对照 {len(counts)} 份；实际任务后代共 {sum(c['generated'] for c in counts)} 个，已评价 {sum(c['evaluated'] for c in counts)} 个。各基准分别评价；这些执行不计为主研究的继承执行。")
        elif counts:
            self.related_summary.setText(f"关联对照 {len(counts)} 份；部分旧报告未记录实际后代数量，不补为零。")
        else:
            self.related_summary.setText("")
        self.comparison_choice.blockSignals(True); self.comparison_choice.clear()
        for row in self._comparison_rows:
            report = row["report"]; benchmark = report.get("benchmark") or row["benchmark"]
            self.comparison_choice.addItem(f"{benchmark.get('title', '旧对照报告')} [{benchmark.get('id', '基准未记录')}] · {row['id']}", row["id"])
        if selected is not None:
            index = self.comparison_choice.findData(selected)
            if index >= 0: self.comparison_choice.setCurrentIndex(index)
        self.comparison_choice.blockSignals(False)
        self.comparison_choice.setEnabled(bool(self._comparison_rows))
        self._comparison_state = deepcopy(state)
        self._comparison_selected()

    def _comparison_selected(self):
        index = self.comparison_choice.currentIndex()
        row = self._comparison_rows[index] if 0 <= index < len(self._comparison_rows) else None
        self.report = row["report"] if row else None
        state = self._comparison_state
        if row:
            self.report_context.setText(self._identity_text(row))
            self.comparison_choice.setToolTip(self._identity_text(row))
        elif state.get("kind") == "meta_evaluation":
            self.report_context.setText(self._identity_text({"id": state.get("id"),
                "registration": state.get("registration"), "benchmark": state.get("benchmark"),
                "origin": (state.get("registration") or {}).get("origin_study")}))
        else:
            self.report_context.setText("按来源研究关联已完成的独立对照；刷新记录后可查看新完成的目标基准。")
            self.comparison_choice.setToolTip("")
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
        offspring = self._offspring_counts(report)
        if offspring is not None:
            pieces.insert(1, f"<p>本对照实际任务后代 {offspring['generated']} 个，已评价 {offspring['evaluated']} 个；初始改进器产生 {offspring['initial']} 个，演化改进器产生 {offspring['evolved']} 个。后代数量不代表效能提高。</p>")
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
        offspring = self._offspring_counts(result)
        if offspring is not None:
            pieces.insert(1, f"<p>开发探测实际任务后代 {offspring['generated']} 个，已评价 {offspring['evaluated']} 个。探测执行完成不代表产生了后代或取得增益。</p>")
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
