from setuptools import setup, find_packages


setup(
    name="nexgent",
    version="0.5.0",
    description="A traceable, self-diagnosing Coding Harness for long-running research simulations",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="csxq0605",
    url="https://github.com/csxq0605/Nexgent",
    license="MIT",
    packages=find_packages(exclude=("tests", "tests.*")),
    include_package_data=True,
    package_data={"nexgent": ["resources/*.png", "resources/*.svg"]},
    python_requires=">=3.10",
    install_requires=[
        "openai>=1.0.0",
        "python-dotenv>=1.0.0",
        "requests>=2.28.0",
        "tiktoken>=0.5.0",
        "prompt_toolkit>=3.0.0",
        "rich>=13.0.0",
        "textual>=0.40.0",
        "pyyaml>=6.0.0",
        "PyQt6>=6.8.0,<7.0.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "pytest-cov>=4.0.0",
            "pytest-qt>=4.5.0,<5.0.0",
        ],
        "demo": [
            "bcrypt>=4.0.0",
            "email-validator>=2.0.0",
            "fastapi>=0.100.0",
            "PyJWT>=2.8.0",
            "SQLAlchemy>=2.0.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "nexgent=nexgent.cli:main",
            "nexgent-gui=nexgent.gui.app:main",
            "nexgent-verify-run=nexgent.runtime.verify:main",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "Operating System :: OS Independent",
    ],
)
