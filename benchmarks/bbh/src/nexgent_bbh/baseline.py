"""Fixed algorithmic control, independent of the official answer files."""

TASK_SOURCE = '''def bbh_atom(tokens, index):
    token = tokens[index]
    if token == "not":
        value, index = bbh_atom(tokens, index + 1)
        return not value, index
    if token == "(":
        value, index = bbh_or(tokens, index + 1)
        if tokens[index] != ")":
            raise ValueError("Expected a closing parenthesis")
        return value, index + 1
    if token not in ["True", "False"]:
        raise ValueError("Unknown Boolean token")
    return token == "True", index + 1

def bbh_and(tokens, index):
    value, index = bbh_atom(tokens, index)
    while index < len(tokens) and tokens[index] == "and":
        right, index = bbh_atom(tokens, index + 1)
        value = value and right
    return value, index

def bbh_or(tokens, index):
    value, index = bbh_and(tokens, index)
    while index < len(tokens) and tokens[index] == "or":
        right, index = bbh_and(tokens, index + 1)
        value = value or right
    return value, index

def solve(problem, tools):
    prompt = problem["input"]
    if problem["category"] == "word_sorting":
        if "List:" not in prompt:
            raise ValueError("Word sorting needs the public List: input")
        return {"answer": " ".join(sorted(prompt.split("List:", 1)[1].split()))}
    if problem["category"] == "boolean_expressions":
        tokens = prompt.replace("(", " ( ").replace(")", " ) ").split()
        if tokens and tokens[-1] == "is":
            tokens = tokens[:-1]
        value, index = bbh_or(tokens, 0)
        if index != len(tokens):
            raise ValueError("Unexpected remaining Boolean tokens")
        return {"answer": "True" if value else "False"}
    raise ValueError("Unsupported task category")
'''
