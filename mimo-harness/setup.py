from setuptools import setup, find_packages

setup(
    name="mimo-harness",
    version="0.3.0",
    description="A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="Agent Learning Hub",
    url="https://github.com/csxq0605/Agent-Learning-Hub-MiMo",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=[
        "openai>=1.0.0",
        "python-dotenv>=1.0.0",
        "requests>=2.28.0",
        "tiktoken>=0.5.0",
        "prompt_toolkit>=3.0.0",
        "rich>=13.0.0",
        "textual>=0.40.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "pytest-cov>=4.0.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "mimo-harness=mimo_harness.cli:main",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
)
