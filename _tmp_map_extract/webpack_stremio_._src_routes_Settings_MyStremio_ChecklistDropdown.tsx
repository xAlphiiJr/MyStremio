"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = __importStar(require("react"));
var classnames_1 = __importDefault(require("classnames"));
var Option_less_1 = __importDefault(require("../../../components/MultiselectMenu/Dropdown/Option/Option.less"));
var MyStremio_less_1 = __importDefault(require("./MyStremio.less"));
var NativeDropdown_1 = __importDefault(require("./NativeDropdown"));
var ChecklistDropdown = function (_a) {
    var items = _a.items, emptyLabel = _a.emptyLabel, onToggle = _a.onToggle;
    var _b = (0, react_1.useState)(false), open = _b[0], setOpen = _b[1];
    var summary = (0, react_1.useMemo)(function () {
        var selectedLabels = items.filter(function (item) { return item.checked; }).map(function (item) { return item.label; });
        return selectedLabels.length ? selectedLabels.join(', ') : emptyLabel;
    }, [emptyLabel, items]);
    return (react_1.default.createElement(NativeDropdown_1.default, { summary: summary, open: open, onToggle: function () { return setOpen(function (prev) { return !prev; }); }, onClose: function () { return setOpen(false); } }, items.map(function (item) { return (react_1.default.createElement("button", { key: item.id, type: 'button', className: (0, classnames_1.default)(Option_less_1.default['option'], MyStremio_less_1.default['checklist-row']), onClick: function () { return onToggle(item.id, !item.checked); } },
        react_1.default.createElement("span", { className: (0, classnames_1.default)(Option_less_1.default['label'], MyStremio_less_1.default['checklist-label']) }, item.label),
        react_1.default.createElement("span", { className: item.checked ? MyStremio_less_1.default['check-on'] : MyStremio_less_1.default['check-off'] }))); })));
};
exports.default = ChecklistDropdown;
