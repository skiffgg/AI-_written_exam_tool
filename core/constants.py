# core/constants.py
import collections # 导入 collections 以便使用 OrderedDict (如果需要保持插入顺序)

# --- 默认模型设置 ---
# 这些是您提供的默认值
DEFAULT_MODEL_OPENAI = "gpt-4o"
DEFAULT_MODEL_GEMINI = "gemini-2.5-flash-preview-04-17"
DEFAULT_MODEL_CLAUDE = "claude-3.7-sonnet"
DEFAULT_MODEL_GROK = "grok-1.5"

# --- 模型供应商标识符 ---
# 使用一个简单的类来存储供应商标识符，方便引用和扩展
class ModelProvider:
    OPENAI = "openai"
    GEMINI = "gemini"
    CLAUDE = "claude"
    GROK = "grok"
    # 如果未来要添加新的供应商，在这里添加一个新的属性即可
    # EXAMPLE_PROVIDER = "example_provider"

# --- 各供应商的可用模型 ---
# 这些字典直接从您提供的内容转换而来
# 键是模型ID (用于API调用)，值是用户友好的显示名称

_AVAILABLE_OPENAI_MODELS = collections.OrderedDict([
    ("gpt-4o", "OpenAI GPT-4o (旗舰多模态)"),
    ("o4-mini", "OpenAI o4-mini (快速)"),
    ("o3", "OpenAI o3 (强大)"),
    ("o1-pro", "OpenAI o1-pro (高质量)"),
    ("gpt-4.1", "OpenAI GPT-4.1 (新一代旗舰)"),
    ("gpt-4.1-mini", "OpenAI GPT-4.1 Mini (轻量)"),
    ("gpt-4.1-nano", "OpenAI GPT-4.1 Nano (超轻量)"),
    ("gpt-3.5-turbo", "OpenAI GPT-3.5 Turbo (均衡)")
])

_AVAILABLE_GEMINI_MODELS = collections.OrderedDict([
    ("gemini-2.5-pro-preview-05-06", "Gemini 2.5 Pro (实验版)"),
    ("gemini-2.5-flash-preview-04-17", "Gemini 2.5 Flash (实验版)"),
    ("gemini-2.0-flash", "Gemini 2.0 Flash Spark (增强多模态)"),
    ("gemini-1.5-pro", "Gemini 1.5 Pro (强大)"),
    ("gemini-1.5-flash", "Gemini 1.5 Flash (快速)"),
    ("gemini-1.0-pro", "Gemini 1.0 Pro (均衡)")
])

_AVAILABLE_CLAUDE_MODELS = collections.OrderedDict([
    ("claude-3.7-sonnet", "Claude 3.7 Sonnet (最新混合推理)"),
    ("claude-3.5-sonnet", "Claude 3.5 Sonnet (强大)"),
    ("claude-3.5-haiku", "Claude 3.5 Haiku (快速)"),
    ("claude-3-opus", "Claude 3 Opus (旗舰)"),
    ("claude-3-sonnet", "Claude 3 Sonnet (均衡)"),
    ("claude-3-haiku", "Claude 3 Haiku (快速)")
])

_AVAILABLE_GROK_MODELS = collections.OrderedDict([
    ("grok-1.5", "Grok 1.5 (X AI 模型，实时上下文)"),
    ("grok-1", "Grok 1.0 (早期版本)")
])

# --- 所有模型总表 (供前端和后端使用) ---
# 使用 ModelProvider 中的标识符作为键，保持一致性
# 使用 collections.OrderedDict 可以确保前端展示时供应商的顺序与您在此处定义的顺序一致 (如果需要)
ALL_AVAILABLE_MODELS = collections.OrderedDict([
    (ModelProvider.OPENAI, _AVAILABLE_OPENAI_MODELS),
    (ModelProvider.GEMINI, _AVAILABLE_GEMINI_MODELS),
    (ModelProvider.CLAUDE, _AVAILABLE_CLAUDE_MODELS),
    (ModelProvider.GROK, _AVAILABLE_GROK_MODELS)
    # --- 新增供应商示例 ---
    # (ModelProvider.EXAMPLE_PROVIDER, collections.OrderedDict([
    # ("model-x": "Example Provider Model X (Feature A)",
    # ("model-y": "Example Provider Model Y (Feature B)",
    # ]))
])

# --- 获取默认模型的辅助函数 ---
def get_default_model_for_provider(provider_identifier: str) -> str | None:
    """
    根据供应商标识符获取其推荐的默认模型ID。
    """
    if provider_identifier == ModelProvider.OPENAI:
        return DEFAULT_MODEL_OPENAI
    elif provider_identifier == ModelProvider.GEMINI:
        return DEFAULT_MODEL_GEMINI
    elif provider_identifier == ModelProvider.CLAUDE:
        return DEFAULT_MODEL_CLAUDE
    elif provider_identifier == ModelProvider.GROK:
        return DEFAULT_MODEL_GROK
    # elif provider_identifier == ModelProvider.EXAMPLE_PROVIDER:
        # return "model-x" # 假设 "model-x" 是 EXAMPLE_PROVIDER 的默认模型
    
    # 如果没有匹配的供应商，或者该供应商没有配置默认模型，则尝试从其模型列表中取第一个
    # （这部分逻辑可以根据您的需求调整，例如返回 None 或抛出错误）
    if provider_identifier in ALL_AVAILABLE_MODELS and ALL_AVAILABLE_MODELS[provider_identifier]:
        return next(iter(ALL_AVAILABLE_MODELS[provider_identifier])) # 返回第一个模型的ID
    
    return None # 如果找不到合适的默认模型

# --- 为后端提供一个简化的所有模型ID列表 (用于验证) ---
# 这个列表只包含模型ID，不包含显示名称，主要用于快速检查模型ID是否存在
FLAT_MODEL_ID_LIST = [
    model_id
    for provider_models in ALL_AVAILABLE_MODELS.values()
    for model_id in provider_models.keys()
]

# --- (可选) 提供一个包含模型ID和其所属提供商的扁平化字典 ---
# 这在后端需要快速查找某个模型ID属于哪个提供商时可能有用
MODEL_TO_PROVIDER_MAP = {
    model_id: provider_key
    for provider_key, provider_models in ALL_AVAILABLE_MODELS.items()
    for model_id in provider_models.keys()
}
