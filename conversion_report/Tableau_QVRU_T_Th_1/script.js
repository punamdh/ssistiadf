let source;
const componentTypes = new Set();
const jobTypes = new Set();
let jobNames = new Set();

const successComponents = new Set();
const warningComponents = new Set();
const failedComponents = new Set();

const ALL_OPTION = "All";
const NO_GENERATED_COMPONENTS = "No Generated Components";

let currentStatusFilter = "All"; // 'All' | 'Error' | 'Warning' | 'Success'

function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Data conversion: turns the raw JobConversionStatus JSON (produced by the
// real conversion run) into a flat, paired source/generated component list.
// ---------------------------------------------------------------------------

function convertJobConversionStatusToReport(jobConversionStatus) {
    if (!jobConversionStatus) {
        return {
            jobName: "Unknown",
            sourceToolName: window.sourceToolName || "Unknown",
            targetToolName: window.targetToolName || "Unknown",
            conversionStatus: "Unknown",
            sourceComponents: [],
            validationResults: []
        };
    }

    // Components are keyed by jobName+name (not just name) so same-named components in different
    // nested flows (e.g. two DataFlows that both have a "Filter1") don't collide/overwrite each other.
    function componentKey(jobName, name) {
        return (jobName || "Unknown Job") + "::" + name;
    }

    const allComponents = [];

    // depth: nesting level (0 = top-level pipeline, 1 = a DataFlow/SubControlFlow nested directly
    // inside it, 2 = nested inside that, etc.). ownerKey: the componentKey of the specific source
    // component this one is nested under (null at depth 0) - used below to attach each nested flow
    // to the exact item that owns it, instead of flattening/grouping everything by job name.
    //
    // Only recurses from the adoption-side occurrence of a component (source ends in _ADOPTION, or
    // is absent). The generation-side occurrence of the same activity/component carries the SAME
    // jobConversionStatus reference (see ConversionStatusHandler.getActivityConversionStatusForGeneratedComponents),
    // so recursing from both would collect every nested component twice.
    function collectAllComponents(jobStatus, parentJobName, parentJobType, depth, ownerKey) {
        if (jobStatus.components && Array.isArray(jobStatus.components)) {
            jobStatus.components.forEach((component) => {
                const thisJobName = jobStatus.name || parentJobName || "Unknown Job";
                allComponents.push({
                    ...component,
                    jobType: jobStatus.jobType || parentJobType || "UNKNOWN",
                    jobName: thisJobName,
                    depth: depth,
                    ownerKey: ownerKey || null
                });
                const isAdoptionSide = component.source === "COMPONENT_ADOPTION" || component.source === "ACTIVITY_ADOPTION" || !component.source;
                if (component.jobConversionStatus && isAdoptionSide) {
                    collectAllComponents(component.jobConversionStatus, jobStatus.name, jobStatus.jobType,
                        depth + 1, componentKey(thisJobName, component.name));
                }
            });
        }
    }

    collectAllComponents(jobConversionStatus, null, null, 0, null);

    const sourceComponentsMap = {};
    const generatedComponents = [];
    // Azure SDK validation outcomes (Source.GENERATION_VALIDATION) are NOT components - they're
    // per-generated-artifact schema checks, so they're collected separately here and rendered in
    // their own report section rather than being mixed into the component list.
    const validationResultsMap = {};

    allComponents.forEach((component, index) => {
        const componentSource = component.source;
        if (!component.name) return;

        if (componentSource === "COMPONENT_ADOPTION" || componentSource === "ACTIVITY_ADOPTION" || !componentSource) {
            const sourceComp = {
                componentId: component.name + "_" + index,
                componentKey: componentKey(component.jobName, component.name),
                ownerKey: component.ownerKey || null,
                componentName: component.name,
                componentType: component.type || "Unknown",
                jobType: component.jobType || "UNKNOWN",
                jobName: component.jobName || "Unknown Job",
                depth: component.depth || 0,
                messages: convertMessages(component.messages || []),
                typeProperties: component.typeProperties || [],
                generatedComponents: [],
                nestedComponents: [],
                inConnections: [],
                outConnections: []
            };
            sourceComponentsMap[sourceComp.componentKey] = sourceComp;
        } else if (componentSource === "COMPONENT_GENERATION" || componentSource === "ACTIVITY_GENERATION") {
            generatedComponents.push({
                componentName: component.name,
                componentType: component.type || "Unknown",
                messages: convertMessages(component.messages || []),
                parent: component.parent,
                jobName: component.jobName
            });
        } else if (componentSource === "GENERATION_VALIDATION") {
            // Keyed so a resource validated more than once (e.g. the same artifact written by two
            // save() passes) collapses to a single row instead of appearing twice.
            validationResultsMap[componentKey(component.jobName, component.name)] = {
                resourceName: component.name,
                resourceType: component.type || "Unknown",
                conversionStatus: component.conversionStatus,
                jobName: component.jobName || "Unknown Job",
                messages: convertMessages(component.messages || [])
            };
        }
    });

    generatedComponents.forEach((genComp) => {
        // For most components/activities, .parent is a self-reference (the adopted item's own name),
        // so this is the key to look up. But for an ECTFlow/SubControlFlow-type activity, .parent
        // instead names its OUTER container (e.g. the pipeline it lives in) - both its adopted and
        // generated entries carry that same outer name, so neither can match the other through it.
        // Fall back to matching by the generated entry's own name against an adopted entry of the
        // same name, which is what actually ties those two together.
        let key = componentKey(genComp.jobName, genComp.parent);
        if (!(genComp.parent && sourceComponentsMap[key])) {
            const nameKey = componentKey(genComp.jobName, genComp.componentName);
            if (sourceComponentsMap[nameKey]) {
                key = nameKey;
            } else {
                return;
            }
        }
        sourceComponentsMap[key].generatedComponents.push({
            componentName: genComp.componentName,
            componentType: genComp.componentType,
            messages: genComp.messages
        });
    });

    // Attach each source component to the specific item that owns its containing flow, so it renders
    // nested inside that item's own tile rather than as a separate section.
    Object.values(sourceComponentsMap).forEach((comp) => {
        if (comp.ownerKey && sourceComponentsMap[comp.ownerKey]) {
            sourceComponentsMap[comp.ownerKey].nestedComponents.push(comp);
        }
    });

    const sourceComponents = Object.values(sourceComponentsMap);

    const conversionStatusStr = jobConversionStatus.conversionStatus
        ? (jobConversionStatus.conversionStatus === "SUCCESS" ? "Completed" : jobConversionStatus.conversionStatus)
        : "Unknown";

    return {
        jobName: jobConversionStatus.name || "Unknown",
        sourceToolName: window.sourceToolName || "Unknown",
        targetToolName: window.targetToolName || "Unknown",
        conversionStatus: conversionStatusStr,
        sourceComponents: sourceComponents,
        validationResults: Object.values(validationResultsMap)
    };
}

function convertMessages(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return [];
    return messages.map(msg => ({
        message: msg.message || "No message",
        messageCategory: convertPriorityToCategory(msg.messageType)
    }));
}

function convertPriorityToCategory(priority) {
    if (!priority) return "Info";
    switch (String(priority).toUpperCase()) {
        case "ERROR": return "Error";
        case "WARNING":
        case "WARN": return "Warning";
        case "SUCCESS": return "Success";
        default: return "Info";
    }
}

function reorderComponents(response, inComponents) {
    if (!response || !Array.isArray(response)) return [];
    const outComponents = [];
    const processComponents = [];
    for (const src of response) {
        const inConnections = src.inConnections || [];
        const outConnections = src.outConnections || [];
        if (inConnections.length < 1 && outConnections.length > 0) inComponents.push(src);
        else if (inConnections.length > 0 && outConnections.length < 1) outComponents.push(src);
        else processComponents.push(src);
    }
    return [...inComponents, ...processComponents, ...outComponents];
}

// ---------------------------------------------------------------------------
// Message counting / component status classification
// ---------------------------------------------------------------------------

function getMessageCount(messages, countMsg = { successMessages: 0, infoMessages: 0, errorMessages: 0, warnMessages: 0 }) {
    if (messages && Array.isArray(messages)) {
        for (const msg of messages) {
            switch (msg.messageCategory) {
                case "Success": countMsg.successMessages++; break;
                case "Info": countMsg.infoMessages++; break;
                case "Error": countMsg.errorMessages++; break;
                case "Warning": countMsg.warnMessages++; break;
                default: break;
            }
        }
    }
    return countMsg;
}

function countBadgesForSrcComponent(currSrcComp) {
    const sourceMessages = currSrcComp.messages || [];
    const generatedComponents = currSrcComp.generatedComponents || [];
    let counts = { successMessages: 0, infoMessages: 0, errorMessages: 0, warnMessages: 0 };

    counts = getMessageCount(sourceMessages, counts);
    for (const genComponent of generatedComponents) {
        counts = getMessageCount(genComponent.messages, counts);
    }

    if (counts.errorMessages > 0) failedComponents.add(currSrcComp.componentId);
    else if (counts.warnMessages > 0) warningComponents.add(currSrcComp.componentId);
    else successComponents.add(currSrcComp.componentId);

    if (currSrcComp.jobName) jobNames.add(currSrcComp.jobName);

    return counts;
}

// ---------------------------------------------------------------------------
// Overall summary (KPIs), computed once from the full unfiltered component list
// ---------------------------------------------------------------------------

function computeOverallSummary(allComponents) {
    const summary = {
        totalComponents: allComponents.length,
        errorComponents: 0, warnComponents: 0, successComponents: 0,
        totalMessages: { error: 0, warn: 0, info: 0, success: 0 },
        propsTotal: 0, propsMapped: 0
    };

    for (const comp of allComponents) {
        let counts = getMessageCount(comp.messages || []);
        for (const gen of (comp.generatedComponents || [])) counts = getMessageCount(gen.messages || [], counts);

        summary.totalMessages.error += counts.errorMessages;
        summary.totalMessages.warn += counts.warnMessages;
        summary.totalMessages.info += counts.infoMessages;
        summary.totalMessages.success += counts.successMessages;

        if (counts.errorMessages > 0) summary.errorComponents++;
        else if (counts.warnMessages > 0) summary.warnComponents++;
        else summary.successComponents++;

        const byName = new Map();
        for (const prop of (comp.typeProperties || [])) {
            if (!byName.has(prop.name)) byName.set(prop.name, {});
            if (prop.conversionStatus === "PARTIAL") byName.get(prop.name).source = prop.value;
            else if (prop.conversionStatus === "SUCCESS") byName.get(prop.name).generated = prop.value;
        }
        byName.forEach(v => {
            summary.propsTotal++;
            if (v.source !== undefined && v.generated !== undefined) summary.propsMapped++;
        });
    }

    return summary;
}

function renderStatusBar(summary) {
    const bar = document.getElementById("statusBar");
    if (!bar) return;
    let label, dot, textColor, bg;
    if (summary.errorComponents > 0) { label = "Completed with Errors"; dot = "bg-error"; textColor = "text-error"; bg = "bg-red-50"; }
    else if (summary.warnComponents > 0) { label = "Completed with Warnings"; dot = "bg-amber-500"; textColor = "text-amber-700"; bg = "bg-amber-50"; }
    else { label = "Completed Successfully"; dot = "bg-tertiary"; textColor = "text-tertiary"; bg = "bg-emerald-50"; }
    const successPct = summary.totalComponents ? Math.round((summary.successComponents / summary.totalComponents) * 1000) / 10 : 0;
    bar.innerHTML = `<span class="inline-flex items-center gap-1 px-2 py-[3px] rounded ${bg} ${textColor} font-mono text-[12px] font-semibold"><span class="w-2 h-2 rounded-full ${dot}"></span>${label}</span>
        <span class="font-mono text-[12px] text-on-surface-variant">${successPct}% of components clean (no errors/warnings)</span>`;
}

function kpiCard(label, value, sub, extraHtml) {
    const card = document.createElement('div');
    card.className = "bg-surface-container-lowest rounded p-3 shadow-sm flex flex-col gap-2";
    card.innerHTML = `<span class="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">${escapeHtml(label)}</span>
        <div class="flex items-baseline gap-1"><span class="text-[26px] font-bold text-on-surface">${escapeHtml(String(value))}</span><span class="text-[12px] text-on-surface-variant">${escapeHtml(sub)}</span></div>
        ${extraHtml || ''}`;
    return card;
}

function renderKpiCards(summary) {
    const container = document.getElementById("kpiCards");
    if (!container) return;
    container.innerHTML = '';

    const successPct = summary.totalComponents ? Math.round((summary.successComponents / summary.totalComponents) * 1000) / 10 : 0;
    const propsPct = summary.propsTotal ? Math.round((summary.propsMapped / summary.propsTotal) * 1000) / 10 : null;
    const totalMsgs = summary.totalMessages.error + summary.totalMessages.warn + summary.totalMessages.info + summary.totalMessages.success;

    container.appendChild(kpiCard("Total Components", summary.totalComponents, "Converted",
        `<div class="flex items-center gap-3 text-[11px] font-mono text-on-surface-variant"><span>Success: <strong class="text-tertiary">${summary.successComponents}</strong></span><span>Warnings: <strong class="text-amber-600">${summary.warnComponents}</strong></span><span>Errors: <strong class="text-error">${summary.errorComponents}</strong></span></div>`));

    container.appendChild(kpiCard("Component Success Rate", successPct + "%", "No warnings/errors",
        `<div class="text-[12px] text-on-surface-variant">Based on ${summary.totalComponents} converted component(s).</div>`));

    container.appendChild(kpiCard("Message Diagnostics", totalMsgs, "Messages Logged",
        `<div class="flex items-center gap-2 text-[11px] font-mono"><span class="px-1.5 py-[1px] rounded bg-red-50 text-error">${summary.totalMessages.error} Errors</span><span class="px-1.5 py-[1px] rounded bg-amber-50 text-amber-700">${summary.totalMessages.warn} Warnings</span><span class="px-1.5 py-[1px] rounded bg-surface-container text-on-surface-variant">${summary.totalMessages.info} Info</span></div>`));

    container.appendChild(kpiCard("Properties Compared", summary.propsTotal ? (summary.propsMapped + "/" + summary.propsTotal) : "—",
        propsPct !== null ? propsPct + "% Mapped" : "Not tracked for these component types",
        `<div class="text-[12px] text-on-surface-variant">Adopted vs. generated property values, where tracked.</div>`));
}

function renderStatusChips(summary) {
    const container = document.getElementById("statusChips");
    if (!container) return;
    container.innerHTML = '';
    const chips = [
        { key: "All", label: "All", count: summary.totalComponents, dot: "bg-outline" },
        { key: "Error", label: "Manual Review", count: summary.errorComponents, dot: "bg-error" },
        { key: "Warning", label: "Warnings", count: summary.warnComponents, dot: "bg-amber-500" },
        { key: "Success", label: "Success", count: summary.successComponents, dot: "bg-tertiary" }
    ];
    chips.forEach(chip => {
        const btn = document.createElement('button');
        btn.className = "px-3 py-1 rounded text-[12px] font-semibold flex items-center gap-1 transition-colors " +
            (currentStatusFilter === chip.key ? "bg-surface-container text-on-surface" : "hover:bg-surface-container-low text-on-surface-variant");
        btn.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${chip.dot}"></span><span>${chip.label}</span><span class="px-1 rounded-full bg-surface-container-highest text-on-surface-variant text-[10px]">${chip.count}</span>`;
        btn.addEventListener('click', () => {
            currentStatusFilter = chip.key;
            renderStatusChips(summary);
            filterData();
        });
        container.appendChild(btn);
    });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function filterData() {
    if (!source || !Array.isArray(source)) return;
    let tempComponents = [...source];

    const typeSelect = document.getElementById("selectedType");
    const searchInput = document.getElementById("searchTerm");
    const selectedType = typeSelect ? typeSelect.value : "";
    const searchTerm = searchInput ? searchInput.value : "";

    if (selectedType && selectedType !== ALL_OPTION) {
        tempComponents = tempComponents.filter(src => src.componentType === selectedType);
    }

    if (currentStatusFilter === "Error") {
        tempComponents = tempComponents.filter(src => failedComponents.has(src.componentId));
    } else if (currentStatusFilter === "Warning") {
        tempComponents = tempComponents.filter(src => warningComponents.has(src.componentId));
    } else if (currentStatusFilter === "Success") {
        tempComponents = tempComponents.filter(src => successComponents.has(src.componentId));
    }

    if (searchTerm) {
        const lower = searchTerm.toLowerCase();
        tempComponents = tempComponents.filter(x => x.componentName.toLowerCase().includes(lower));
    }

    populateComponentDetails(tempComponents);
}

function resetFilters() {
    const typeSelect = document.getElementById("selectedType");
    const searchInput = document.getElementById("searchTerm");
    if (typeSelect) typeSelect.value = "";
    if (searchInput) searchInput.value = "";
    currentStatusFilter = "All";
    const summary = computeOverallSummary(source || []);
    renderStatusChips(summary);
    if (source && Array.isArray(source)) populateComponentDetails(source);
}

function populateDropdowns() {
    const options = Array.from(componentTypes);
    const selectedType = document.getElementById("selectedType");
    if (selectedType) {
        selectedType.innerHTML = '';
        selectedType.add(new Option('All Component Types', ALL_OPTION));
        options.forEach(option => selectedType.add(new Option(option, option)));
    }
}

// ---------------------------------------------------------------------------
// Component tiles
// ---------------------------------------------------------------------------

function statusPill(counts) {
    const span = document.createElement('span');
    let label, cls;
    if (counts.errorMessages > 0) {
        label = `Manual Review (${counts.errorMessages} Error${counts.errorMessages > 1 ? 's' : ''})`;
        cls = "bg-red-50 text-error";
    } else if (counts.warnMessages > 0) {
        label = `Converted with Warnings (${counts.warnMessages})`;
        cls = "bg-amber-50 text-amber-700";
    } else {
        label = "Converted Successfully";
        cls = "bg-emerald-50 text-tertiary";
    }
    span.className = `px-2 py-[2px] rounded font-mono text-[11px] font-semibold whitespace-nowrap ${cls}`;
    span.textContent = label;
    return span;
}

function createMsgBadge(count, msgType) {
    const span = document.createElement('span');
    const styles = {
        error: "bg-red-50 text-error", warn: "bg-amber-50 text-amber-700",
        info: "bg-sky-50 text-sky-700", success: "bg-emerald-50 text-tertiary"
    };
    span.className = `px-1.5 py-[1px] rounded font-mono text-[10px] font-semibold ${styles[msgType] || ''} ${count === 0 ? 'opacity-40' : ''}`;
    span.textContent = count;
    span.title = msgType + " messages";
    return span;
}

function sectionLabel(text) {
    const div = document.createElement('div');
    div.className = "text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant";
    div.textContent = text;
    return div;
}

function appendMessageList(messages, container) {
    if (!messages || messages.length === 0) {
        const p = document.createElement('div');
        p.className = "placeholder-value font-mono text-[12px] py-1";
        p.textContent = "No messages";
        container.appendChild(p);
        return;
    }
    const styleFor = {
        Error: ["error", "bg-red-50 text-red-900"],
        Warning: ["warning", "bg-amber-50 text-amber-900"],
        Success: ["check_circle", "bg-emerald-50 text-emerald-900"],
        Info: ["info", "bg-surface-container text-on-surface-variant"]
    };
    for (const msg of messages) {
        const [icon, cls] = styleFor[msg.messageCategory] || styleFor.Info;
        const item = document.createElement('div');
        item.className = `p-2 rounded flex items-start gap-1.5 font-mono text-[11px] ${cls}`;
        item.innerHTML = `<span class="material-symbols-outlined text-[15px] mt-[1px]">${icon}</span><span>${escapeHtml(msg.message)}</span>`;
        container.appendChild(item);
    }
}

function diagnosticsPanel(title, icon, iconColorClass, messages) {
    const panel = document.createElement('div');
    panel.className = "bg-surface-container-low rounded p-3 flex flex-col gap-2";
    const header = document.createElement('div');
    header.className = "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant border-b border-surface-container pb-1";
    header.innerHTML = `<span class="material-symbols-outlined text-[15px] ${iconColorClass}">${icon}</span><span>${escapeHtml(title)}</span>`;
    panel.appendChild(header);
    appendMessageList(messages, panel);
    return panel;
}

// Always-visible two-column layout: left = source diagnostics, right = every
// generated component's diagnostics stacked underneath each other.
function renderMessageComparison(sourceMessages, generatedComponents) {
    const grid = document.createElement('div');
    grid.className = "grid grid-cols-1 lg:grid-cols-2 gap-3";

    grid.appendChild(diagnosticsPanel("Source Diagnostics", "data_object", "text-primary", sourceMessages));

    const rightPanel = document.createElement('div');
    rightPanel.className = "bg-surface-container-low rounded p-3 flex flex-col gap-2";
    const rightHeader = document.createElement('div');
    rightHeader.className = "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant border-b border-surface-container pb-1";
    rightHeader.innerHTML = `<span class="material-symbols-outlined text-[15px] text-tertiary">cloud_sync</span><span>Generated Diagnostics</span>`;
    rightPanel.appendChild(rightHeader);

    if (!generatedComponents || generatedComponents.length === 0) {
        const p = document.createElement('div');
        p.className = "placeholder-value font-mono text-[12px] py-1";
        p.textContent = NO_GENERATED_COMPONENTS;
        rightPanel.appendChild(p);
    } else {
        generatedComponents.forEach((genComp, idx) => {
            if (idx > 0) {
                const hr = document.createElement('hr');
                hr.className = "border-surface-container";
                rightPanel.appendChild(hr);
            }
            const nameEl = document.createElement('div');
            nameEl.className = "flex flex-col min-w-0";
            // Name over type, matching how the source component is presented.
            nameEl.innerHTML = `<span class="componentName font-mono font-semibold text-[13px] text-on-surface">${escapeHtml(genComp.componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(genComp.componentType || "Unknown")}</span>`;
            rightPanel.appendChild(nameEl);
            appendMessageList(genComp.messages, rightPanel);
        });
    }

    grid.appendChild(rightPanel);
    return grid;
}

// Groups typeProperties by name and renders a table: Source (adopted/PARTIAL)
// vs. Generated (SUCCESS) value, with "Not Mapped" / "N/A" fallbacks.
function renderPropertiesPanel(typeProperties) {
    const wrap = document.createElement('div');
    wrap.className = "overflow-x-auto rounded border border-surface-container";
    const table = document.createElement('table');
    table.className = "w-full text-left border-collapse font-mono text-[11px]";
    table.innerHTML = `<thead><tr class="bg-surface-container-high text-on-surface-variant text-[10px] uppercase tracking-wide">
        <th class="py-1.5 px-3 w-1/2">Adopted (Source)</th>
        <th class="py-1.5 px-3 w-1/2">Generated (Target)</th>
        <th class="py-1.5 px-3 text-right">Status</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    tbody.className = "divide-y divide-surface-container";

    const byName = new Map();
    for (const prop of (typeProperties || [])) {
        if (!byName.has(prop.name)) byName.set(prop.name, {});
        if (prop.conversionStatus === "PARTIAL") byName.get(prop.name).source = prop.value;
        else if (prop.conversionStatus === "SUCCESS") byName.get(prop.name).generated = prop.value;
    }

    byName.forEach((values, name) => {
        const hasSource = values.source !== undefined && values.source !== null && values.source !== "";
        const hasGenerated = values.generated !== undefined && values.generated !== null && values.generated !== "";

        let statusHtml;
        if (hasSource && hasGenerated) {
            statusHtml = `<span class="inline-flex items-center gap-1 text-tertiary font-semibold"><span class="material-symbols-outlined text-[14px]">check</span>Mapped</span>`;
        } else if (hasSource) {
            statusHtml = `<span class="inline-flex items-center gap-1 text-amber-700 font-semibold"><span class="material-symbols-outlined text-[14px]">warning</span>Not Mapped</span>`;
        } else {
            statusHtml = `<span class="text-on-surface-variant font-semibold">N/A</span>`;
        }

        const sourceValueHtml = hasSource ? escapeHtml(values.source) : `<span class="placeholder-value">N/A</span>`;
        const generatedValueHtml = hasGenerated ? escapeHtml(values.generated) : `<span class="placeholder-value">Not Mapped</span>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-surface-container-low transition-colors";
        tr.innerHTML = `
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col"><span class="font-semibold text-on-surface">${escapeHtml(name)}</span><span class="text-on-surface-variant">${sourceValueHtml}</span></div></td>
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col"><span class="font-semibold text-primary">${escapeHtml(name)}</span><span class="text-on-surface-variant">${generatedValueHtml}</span></div></td>
          <td class="py-1.5 px-3 text-right">${statusHtml}</td>`;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
}

// ---------------------------------------------------------------------------
// Azure Data Factory validation section
// ---------------------------------------------------------------------------

// Renders the per-artifact Azure SDK schema-validation outcomes (pipelines, dataflows, flowlets)
// in their own section. These are NOT components - they're checks on the generated ADF JSON's
// properties - so they deliberately live outside the component list and its property mappings.
function renderValidationSection(validationResults) {
    const section = document.getElementById("validationSection");
    const container = document.getElementById("validationResults");
    const summaryEl = document.getElementById("validationSummary");
    if (!section || !container) return;

    // Toggled via inline style rather than Tailwind's `hidden`/`flex` classes, which are both
    // display utilities and would compete for precedence if applied to the same element.
    if (!validationResults || validationResults.length === 0) {
        section.style.display = "none";
        return;
    }
    section.style.display = "flex";
    container.innerHTML = '';

    const failed = validationResults.filter(v => v.conversionStatus === "FAIL").length;
    const passed = validationResults.length - failed;
    if (summaryEl) {
        summaryEl.textContent = `${passed}/${validationResults.length} artifact(s) passed`
            + (failed > 0 ? ` — ${failed} need(s) manual review` : "");
    }

    const wrap = document.createElement('div');
    wrap.className = "overflow-x-auto rounded border border-surface-container bg-surface-container-lowest shadow-sm";
    const table = document.createElement('table');
    table.className = "w-full text-left border-collapse font-mono text-[11px]";
    table.innerHTML = `<thead><tr class="bg-surface-container-high text-on-surface-variant text-[10px] uppercase tracking-wide">
        <th class="py-1.5 px-3">Generated Artifact</th>
        <th class="py-1.5 px-3">Type</th>
        <th class="py-1.5 px-3">Status</th>
        <th class="py-1.5 px-3 w-1/2">Validation Findings</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    tbody.className = "divide-y divide-surface-container";

    // Failures first - they're the actionable rows.
    const ordered = [...validationResults].sort((a, b) => {
        const aFail = a.conversionStatus === "FAIL" ? 0 : 1;
        const bFail = b.conversionStatus === "FAIL" ? 0 : 1;
        if (aFail !== bFail) return aFail - bFail;
        return String(a.resourceName).localeCompare(String(b.resourceName));
    });

    for (const result of ordered) {
        const isFail = result.conversionStatus === "FAIL";
        const statusHtml = isFail
            ? `<span class="inline-flex items-center gap-1 px-2 py-[2px] rounded bg-red-50 text-error font-semibold whitespace-nowrap"><span class="material-symbols-outlined text-[14px]">error</span>Failed</span>`
            : `<span class="inline-flex items-center gap-1 px-2 py-[2px] rounded bg-emerald-50 text-tertiary font-semibold whitespace-nowrap"><span class="material-symbols-outlined text-[14px]">check_circle</span>Passed</span>`;

        const findingsHtml = (result.messages && result.messages.length > 0)
            ? result.messages.map(m => `<div class="flex items-start gap-1.5 ${isFail ? 'text-red-900' : 'text-on-surface-variant'}"><span class="material-symbols-outlined text-[14px] mt-[1px]">${isFail ? 'error' : 'check'}</span><span>${escapeHtml(m.message)}</span></div>`).join('')
            : `<span class="placeholder-value">No findings</span>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-surface-container-low transition-colors";
        tr.innerHTML = `
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col"><span class="font-semibold text-on-surface">${escapeHtml(result.resourceName)}</span><span class="text-on-surface-variant">${escapeHtml(result.jobName)}</span></div></td>
          <td class="py-1.5 px-3 align-top whitespace-nowrap text-primary font-semibold">${escapeHtml(result.resourceType)}</td>
          <td class="py-1.5 px-3 align-top">${statusHtml}</td>
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col gap-1">${findingsHtml}</div></td>`;
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
}

// Builds one accordion tile for a single source component, plus - recursively - a "Nested Flow"
// section inside its own body for any components nested under it (e.g. a DataFlow/ForEach/Until
// activity's own internal components), so nested content sits inside the owning item instead of
// being appended as a separate section elsewhere in the report.
//
// keysInView: the Set of componentKeys currently passing the active filter/search (from
// populateComponentDetails); a nested child only renders if it's in that set. Pass null/undefined
// to render every nested child unconditionally.
function buildComponentTile(currSrcComp, keysInView) {
        if (currSrcComp.componentType) componentTypes.add(currSrcComp.componentType);
        if (currSrcComp.jobType) jobTypes.add(currSrcComp.jobType);
        if (currSrcComp.jobName) jobNames.add(currSrcComp.jobName);

        const sourceMessages = currSrcComp.messages || [];
        const generatedComponents = currSrcComp.generatedComponents || [];
        const typeProperties = currSrcComp.typeProperties || [];
        const counts = countBadgesForSrcComponent(currSrcComp);

        const tile = document.createElement('div');
        tile.className = "bg-surface-container-lowest rounded shadow-sm overflow-hidden";

        const header = document.createElement('div');
        header.className = "p-3 bg-surface-container-low flex flex-col md:flex-row md:items-center justify-between gap-2 cursor-pointer select-none";

        const left = document.createElement('div');
        left.className = "flex items-center gap-2 min-w-0";

        const chevron = document.createElement('span');
        chevron.className = "material-symbols-outlined text-primary text-[20px] shrink-0";
        chevron.textContent = "chevron_right";
        left.appendChild(chevron);

        const namesWrap = document.createElement('div');
        namesWrap.className = "flex items-center gap-2 min-w-0 flex-wrap";

        const srcWrap = document.createElement('div');
        srcWrap.className = "flex flex-col min-w-0";
        srcWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-on-surface truncate">${escapeHtml(currSrcComp.componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(currSrcComp.componentType)}</span>`;
        namesWrap.appendChild(srcWrap);

        const arrow = document.createElement('span');
        arrow.className = "material-symbols-outlined text-outline text-[16px]";
        arrow.textContent = "trending_flat";
        namesWrap.appendChild(arrow);

        const genWrap = document.createElement('div');
        genWrap.className = "flex flex-col min-w-0";
        if (generatedComponents.length === 1) {
            // Mirror the source side's name-over-type layout so the generated component's type is
            // just as visible as the adopted one's.
            genWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-primary truncate">${escapeHtml(generatedComponents[0].componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(generatedComponents[0].componentType)}</span>`;
        } else if (generatedComponents.length === 0) {
            genWrap.innerHTML = `<span class="placeholder-value font-mono text-[12px]">${NO_GENERATED_COMPONENTS}</span>`;
        } else {
            // Multiple generated components: summarise the count, with the distinct types beneath so
            // the type information is still surfaced here (per-component detail is in the body).
            const distinctTypes = [...new Set(generatedComponents.map(g => g.componentType).filter(Boolean))];
            genWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-primary">${generatedComponents.length} Generated Components</span><span class="componentType font-mono text-[11px] text-on-surface-variant truncate">${escapeHtml(distinctTypes.join(", "))}</span>`;
        }
        namesWrap.appendChild(genWrap);

        left.appendChild(namesWrap);

        const right = document.createElement('div');
        right.className = "flex items-center gap-2 flex-wrap";
        right.appendChild(statusPill(counts));
        const badgeWrap = document.createElement('div');
        badgeWrap.className = "flex items-center gap-1";
        badgeWrap.appendChild(createMsgBadge(counts.errorMessages, "error"));
        badgeWrap.appendChild(createMsgBadge(counts.warnMessages, "warn"));
        badgeWrap.appendChild(createMsgBadge(counts.infoMessages, "info"));
        badgeWrap.appendChild(createMsgBadge(counts.successMessages, "success"));
        right.appendChild(badgeWrap);

        header.appendChild(left);
        header.appendChild(right);

        const body = document.createElement('div');
        body.className = "hidden p-4 flex flex-col gap-4 border-t border-surface-container";
        body.appendChild(sectionLabel("Messages"));
        body.appendChild(renderMessageComparison(sourceMessages, generatedComponents));
        if (typeProperties.length > 0) {
            body.appendChild(sectionLabel("Property & Value Mappings"));
            body.appendChild(renderPropertiesPanel(typeProperties));
        }

        const visibleNested = (currSrcComp.nestedComponents || []).filter(c => !keysInView || keysInView.has(c.componentKey));
        if (visibleNested.length > 0) {
            const nestedLabel = document.createElement('div');
            nestedLabel.className = "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant";
            nestedLabel.innerHTML = `<span class="material-symbols-outlined text-[14px]">account_tree</span><span>Nested Flow${visibleNested[0].jobName ? ": " + escapeHtml(visibleNested[0].jobName) : ""}</span>`;
            body.appendChild(nestedLabel);

            const nestedWrap = document.createElement('div');
            nestedWrap.className = "ml-2 pl-3 border-l-2 border-surface-container flex flex-col gap-3";
            visibleNested.forEach((child) => {
                nestedWrap.appendChild(buildComponentTile(child, keysInView));
            });
            body.appendChild(nestedWrap);
        }

        header.addEventListener('click', () => {
            const isHidden = body.classList.toggle('hidden');
            chevron.textContent = isHidden ? 'chevron_right' : 'expand_more';
        });

        tile.appendChild(header);
        tile.appendChild(body);
        return tile;
}

// Renders component tiles. Only "top-level" components are appended directly to the accordion -
// everything nested under one (a DataFlow/ForEach/Until activity's own components) renders inside
// that owning tile's own body (see buildComponentTile), not as a separate section here.
//
// A component counts as top-level for THIS render either because it has no owner, or because its
// owner didn't pass the active filter/search (sourceData is already filtered by the caller) - that
// keeps a filtered/searched-for nested component visible even when its parent got filtered out,
// instead of silently disappearing.
function populateComponentDetails(sourceData) {
    const accordion = document.querySelector(".accordion");
    if (!accordion) return;
    accordion.innerHTML = '';

    if (!sourceData || !Array.isArray(sourceData) || sourceData.length === 0) {
        accordion.innerHTML = '<div class="bg-surface-container-lowest rounded p-4 text-on-surface-variant text-center shadow-sm">No components found.</div>';
        return;
    }

    const keysInView = new Set(sourceData.map(c => c.componentKey));
    const topLevel = sourceData.filter(comp => !comp.ownerKey || !keysInView.has(comp.ownerKey));

    if (topLevel.length === 0) {
        accordion.innerHTML = '<div class="bg-surface-container-lowest rounded p-4 text-on-surface-variant text-center shadow-sm">No components found.</div>';
        return;
    }

    topLevel.forEach((currSrcComp) => {
        accordion.appendChild(buildComponentTile(currSrcComp, keysInView));
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function load() {
    try {
        if (typeof jobConversionData === 'undefined' || jobConversionData === null) {
            const main = document.querySelector('main');
            if (main) main.innerHTML = '<div class="bg-red-50 text-error rounded p-4">Error: No conversion data available.</div>';
            return;
        }

        let parsedData = jobConversionData;
        if (typeof jobConversionData === 'string') {
            try {
                parsedData = JSON.parse(jobConversionData);
            } catch (e) {
                const main = document.querySelector('main');
                if (main) main.innerHTML = '<div class="bg-red-50 text-error rounded p-4">Error: Invalid JSON data.</div>';
                return;
            }
        }

        const convertedReport = convertJobConversionStatusToReport(parsedData);

        const jobnameEl = document.getElementById("jobname");
        const sourcetoolEl = document.getElementById("sourcetool");
        const targettoolEl = document.getElementById("targettool");
        if (jobnameEl) jobnameEl.textContent = convertedReport.jobName || "Unknown";
        if (sourcetoolEl) sourcetoolEl.textContent = convertedReport.sourceToolName || "Unknown";
        if (targettoolEl) targettoolEl.textContent = convertedReport.targetToolName || "Unknown";

        source = Array.isArray(convertedReport.sourceComponents) ? convertedReport.sourceComponents : [];
        source = reorderComponents(source, []);

        const typeSelect = document.getElementById("selectedType");
        const searchInput = document.getElementById("searchTerm");
        if (typeSelect) typeSelect.addEventListener("change", filterData);
        if (searchInput) searchInput.addEventListener("input", filterData);

        populateComponentDetails(source);
        populateDropdowns();

        const summary = computeOverallSummary(source);
        renderStatusBar(summary);
        renderKpiCards(summary);
        renderStatusChips(summary);
        renderValidationSection(convertedReport.validationResults);

        const footer = document.getElementById("footerdate");
        if (footer) footer.innerHTML = "&copy; " + new Date().getFullYear() + " Bitwise. Report generated " + new Date().toLocaleString() + ".";
    } catch (error) {
        console.error("Error in load():", error);
        const jobnameEl = document.getElementById("jobname");
        if (jobnameEl) jobnameEl.textContent = "Error loading report: " + error.message;
    }
}

load();
